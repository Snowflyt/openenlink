// The OS credential store, called through node:ffi. Items have the layout keyring-rs gives them:
// macOS generic passwords, Windows generic credentials named "account.service", and Secret Service
// items with service and username attributes.
export type Keyring = {
  read(service: string, account: string): string | undefined;
  write(service: string, account: string, secret: string): void;
  delete(service: string, account: string): void;
};

let keyring: Keyring | undefined;

// node:ffi prints an ExperimentalWarning when it loads, so it loads on the first call.
// --insecure-storage loads it only to remove a copy left in the OS store.
export function osKeyring(): Keyring {
  keyring ??=
    process.platform === "darwin" ? macos()
    : process.platform === "win32" ? windows()
    : linux();
  return keyring;
}

function macos(): Keyring {
  const { dlopen, toBuffer } = process.getBuiltinModule("node:ffi");
  const { functions: security } = dlopen("/System/Library/Frameworks/Security.framework/Security", {
    SecCopyErrorMessageString: { arguments: ["int32", "pointer"], return: "pointer" },
    SecKeychainAddGenericPassword: {
      arguments: [
        "pointer",
        "uint32",
        "pointer",
        "uint32",
        "pointer",
        "uint32",
        "pointer",
        "pointer",
      ],
      return: "int32",
    },
    SecKeychainFindGenericPassword: {
      arguments: [
        "pointer",
        "uint32",
        "pointer",
        "uint32",
        "pointer",
        "pointer",
        "pointer",
        "pointer",
      ],
      return: "int32",
    },
    SecKeychainItemDelete: { arguments: ["pointer"], return: "int32" },
    SecKeychainItemFreeContent: { arguments: ["pointer", "pointer"], return: "int32" },
    SecKeychainItemModifyAttributesAndData: {
      arguments: ["pointer", "pointer", "uint32", "pointer"],
      return: "int32",
    },
  });
  const { functions: foundation } = dlopen(
    "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
    {
      CFRelease: { arguments: ["pointer"] },
      CFStringGetCString: { arguments: ["pointer", "pointer", "int64", "uint32"], return: "uint8" },
    },
  );
  const ITEM_NOT_FOUND = -25300;
  const UTF8 = 0x0800_0100;

  function check(status: number): void {
    if (status === 0) return;
    let text = `OSStatus ${status}`;
    const message = security.SecCopyErrorMessageString(status, null);
    if (message) {
      const buffer = Buffer.alloc(1024);
      if (foundation.CFStringGetCString(message, buffer, BigInt(buffer.length), UTF8))
        text = buffer.toString("utf8", 0, buffer.indexOf(0));
      foundation.CFRelease(message);
    }
    throw new Error(`Keychain: ${text}`);
  }

  // Null out-parameters are left unfilled; true when the item exists.
  function find(
    service: string,
    account: string,
    out: { length?: Buffer; data?: Buffer; item?: Buffer },
  ): boolean {
    const name = Buffer.from(service);
    const user = Buffer.from(account);
    const status = security.SecKeychainFindGenericPassword(
      null,
      name.length,
      name,
      user.length,
      user,
      out.length ?? null,
      out.data ?? null,
      out.item ?? null,
    );
    if (status === ITEM_NOT_FOUND) return false;
    check(status);
    return true;
  }

  // Runs with a found item and releases it after.
  function withItem(service: string, account: string, run: (item: bigint) => void): boolean {
    const out = Buffer.alloc(8);
    if (!find(service, account, { item: out })) return false;
    const item = out.readBigUInt64LE();
    try {
      run(item);
    } finally {
      foundation.CFRelease(item);
    }
    return true;
  }

  return {
    read(service, account) {
      const length = Buffer.alloc(4);
      const data = Buffer.alloc(8);
      if (!find(service, account, { length, data })) return;
      const pointer = data.readBigUInt64LE();
      const size = length.readUInt32LE();
      const secret = size ? toBuffer(pointer, size, true).toString("utf8") : "";
      if (pointer) security.SecKeychainItemFreeContent(null, pointer);
      return secret;
    },

    write(service, account, secret) {
      const data = Buffer.from(secret);
      const modify = (item: bigint) => {
        check(security.SecKeychainItemModifyAttributesAndData(item, null, data.length, data));
      };
      if (withItem(service, account, modify)) return;
      const name = Buffer.from(service);
      const user = Buffer.from(account);
      check(
        security.SecKeychainAddGenericPassword(
          null,
          name.length,
          name,
          user.length,
          user,
          data.length,
          data,
          null,
        ),
      );
    },

    delete(service, account) {
      withItem(service, account, (item) => check(security.SecKeychainItemDelete(item)));
    },
  };
}

function windows(): Keyring {
  const { dlopen, getRawPointer, getUint32, getUint64, toBuffer } =
    process.getBuiltinModule("node:ffi");
  const { functions: advapi } = dlopen("advapi32.dll", {
    CredDeleteW: { arguments: ["pointer", "uint32", "uint32"], return: "int32" },
    CredFree: { arguments: ["pointer"] },
    CredReadW: { arguments: ["pointer", "uint32", "uint32", "pointer"], return: "int32" },
    CredWriteW: { arguments: ["pointer", "uint32"], return: "int32" },
  });
  const { functions: kernel } = dlopen("kernel32.dll", {
    FormatMessageW: {
      arguments: ["uint32", "pointer", "uint32", "uint32", "pointer", "uint32", "pointer"],
      return: "uint32",
    },
    GetLastError: { return: "uint32" },
  });
  const GENERIC = 1;
  const PERSIST_LOCAL_MACHINE = 2;
  const ERROR_NOT_FOUND = 1168;
  const FORMAT_MESSAGE = 0x1000 | 0x200; // FROM_SYSTEM | IGNORE_INSERTS
  const MAX_BLOB = 2560;

  const wide = (text: string) => Buffer.from(`${text}\0`, "utf16le");
  const target = (service: string, account: string) => wide(`${account}.${service}`);

  function failure(code: number): Error {
    const buffer = Buffer.alloc(1024);
    const length = kernel.FormatMessageW(FORMAT_MESSAGE, null, code, 0, buffer, 512, null);
    const text = length ? buffer.toString("utf16le", 0, length * 2).trim() : `error ${code}`;
    return new Error(`Credential Manager: ${text}`);
  }

  // Runs a Win32 call and returns its error code, or undefined on success. node:ffi reads the
  // last error in a separate call, and the runtime can reset it to 0 in between, so a failure
  // that reports 0 runs once more.
  function call(run: () => number): number | undefined {
    if (run()) return;
    const code = kernel.GetLastError();
    if (code) return code;
    return run() ? undefined : kernel.GetLastError();
  }

  return {
    read(service, account) {
      const out = Buffer.alloc(8);
      const code = call(() => advapi.CredReadW(target(service, account), GENERIC, 0, out));
      if (code === ERROR_NOT_FOUND) return;
      if (code !== undefined) throw failure(code);
      const credential = out.readBigUInt64LE();
      try {
        // CREDENTIALW: CredentialBlobSize at 32, CredentialBlob at 40.
        const size = getUint32(credential, 32);
        return size ? toBuffer(getUint64(credential, 40), size, true).toString("utf16le") : "";
      } finally {
        advapi.CredFree(credential);
      }
    },

    write(service, account, secret) {
      const blob = Buffer.from(secret, "utf16le");
      if (blob.length > MAX_BLOB)
        throw new Error(
          `Credential Manager holds at most ${MAX_BLOB} bytes per secret; use login --insecure-storage`,
        );
      const name = target(service, account);
      const user = wide(account);
      // CREDENTIALW is 80 bytes. The strings and blob follow it in the same buffer, so the
      // pointers inside stay valid while the buffer is the argument.
      const credential = Buffer.alloc(80 + name.length + user.length + blob.length);
      const base = getRawPointer(credential);
      name.copy(credential, 80);
      user.copy(credential, 80 + name.length);
      blob.copy(credential, 80 + name.length + user.length);
      credential.writeUInt32LE(GENERIC, 4);
      credential.writeBigUInt64LE(base + 80n, 8);
      credential.writeUInt32LE(blob.length, 32);
      credential.writeBigUInt64LE(base + BigInt(80 + name.length + user.length), 40);
      credential.writeUInt32LE(PERSIST_LOCAL_MACHINE, 48);
      credential.writeBigUInt64LE(base + BigInt(80 + name.length), 72);
      const code = call(() => advapi.CredWriteW(credential, 0));
      if (code !== undefined) throw failure(code);
    },

    delete(service, account) {
      const code = call(() => advapi.CredDeleteW(target(service, account), GENERIC, 0));
      if (code !== undefined && code !== ERROR_NOT_FOUND) throw failure(code);
    },
  };
}

function linux(): Keyring {
  const { dlopen, getUint32, getUint64, toBuffer, toString } = process.getBuiltinModule("node:ffi");
  const NO_SERVICE =
    "The OS credential store needs a Secret Service such as GNOME Keyring or KWallet; use login --insecure-storage";
  const open = () => {
    try {
      return dlopen("libsecret-1.so.0", {
        secret_item_delete_sync: { arguments: ["pointer", "pointer", "pointer"], return: "int32" },
        secret_item_get_locked: { arguments: ["pointer"], return: "int32" },
        secret_service_get_sync: { arguments: ["int32", "pointer", "pointer"], return: "pointer" },
        secret_service_lookup_sync: {
          arguments: ["pointer", "pointer", "pointer", "pointer", "pointer"],
          return: "pointer",
        },
        secret_service_search_sync: {
          arguments: ["pointer", "pointer", "pointer", "int32", "pointer", "pointer"],
          return: "pointer",
        },
        secret_service_store_sync: {
          arguments: [
            "pointer",
            "pointer",
            "pointer",
            "pointer",
            "pointer",
            "pointer",
            "pointer",
            "pointer",
          ],
          return: "int32",
        },
        secret_value_get: { arguments: ["pointer", "pointer"], return: "pointer" },
        secret_value_new: { arguments: ["pointer", "int64", "pointer"], return: "pointer" },
        secret_value_unref: { arguments: ["pointer"] },
      }).functions;
    } catch (cause) {
      throw new Error("The OS credential store needs libsecret; use login --insecure-storage", {
        cause,
      });
    }
  };
  const libsecret = open();
  const { functions: glib, lib } = dlopen("libglib-2.0.so.0", {
    g_error_free: { arguments: ["pointer"] },
    g_hash_table_insert: { arguments: ["pointer", "pointer", "pointer"], return: "int32" },
    g_hash_table_new_full: {
      arguments: ["pointer", "pointer", "pointer", "pointer"],
      return: "pointer",
    },
    g_hash_table_unref: { arguments: ["pointer"] },
    g_list_free: { arguments: ["pointer"] },
    g_strdup: { arguments: ["string"], return: "pointer" },
  });
  const { functions: gobject } = dlopen("libgobject-2.0.so.0", {
    g_object_unref: { arguments: ["pointer"] },
  });
  const { functions: gio } = dlopen("libgio-2.0.so.0", {
    g_bus_get_sync: { arguments: ["int32", "pointer", "pointer"], return: "pointer" },
    g_dbus_error_quark: { arguments: [], return: "uint32" },
  });
  const BUS_SESSION = 2;
  const DBUS_SERVICE_UNKNOWN = 2;
  const OPEN_SESSION = 1 << 1;
  const free = lib.getSymbol("g_free");
  const SEARCH_ALL = 1 << 1;
  const SEARCH_UNLOCK = 1 << 2;
  const hash = lib.getSymbol("g_str_hash");
  const equal = lib.getSymbol("g_str_equal");

  // A null schema stores exactly these attributes; with a schema, libsecret adds xdg:schema.
  function withAttributes<T>(service: string, account: string, run: (table: bigint) => T): T {
    const table = glib.g_hash_table_new_full(hash, equal, free, free);
    glib.g_hash_table_insert(table, glib.g_strdup("service"), glib.g_strdup(service));
    glib.g_hash_table_insert(table, glib.g_strdup("username"), glib.g_strdup(account));
    try {
      return run(table);
    } finally {
      glib.g_hash_table_unref(table);
    }
  }

  // Runs a call that takes a GError ** last and throws the error it sets. A session bus with
  // no Secret Service on it answers ServiceUnknown; noService reports any error that way.
  function call<T>(run: (error: Buffer) => T, noService = false): T {
    const out = Buffer.alloc(8);
    const result = run(out);
    const error = out.readBigUInt64LE();
    if (!error) return result;
    // GError: domain at 0, code at 4, message at 8.
    const unknown =
      getUint32(error, 0) === gio.g_dbus_error_quark() &&
      getUint32(error, 4) === DBUS_SERVICE_UNKNOWN;
    const message = toString(getUint64(error, 8)) ?? "";
    glib.g_error_free(error);
    if (unknown || noService) throw new Error(NO_SERVICE, { cause: new Error(message) });
    throw new Error(`Secret Service: ${message}`);
  }

  // libsecret reaches the Secret Service over the session bus, which containers and servers
  // without a desktop session lack.
  gobject.g_object_unref(call((error) => gio.g_bus_get_sync(BUS_SESSION, null, error), true));
  // A bus without a provider shows only when a call reaches the Secret Service. Opening a session
  // reaches it without a prompt, starts a provider that D-Bus can activate, and leaves the session
  // to the calls that follow.
  gobject.g_object_unref(
    call((error) => libsecret.secret_service_get_sync(OPEN_SESSION, null, error), true),
  );

  // Runs on every item that matches, then frees the items and the list.
  function each(service: string, account: string, flags: number, run: (item: bigint) => void) {
    const list = withAttributes(service, account, (table) =>
      call((error) => libsecret.secret_service_search_sync(null, null, table, flags, null, error)),
    );
    const items: bigint[] = [];
    // GList: data at 0, next at 8.
    for (let node = list; node; node = getUint64(node, 8)) items.push(getUint64(node, 0));
    try {
      for (const item of items) run(item);
    } finally {
      for (const item of items) gobject.g_object_unref(item);
      glib.g_list_free(list);
    }
  }

  return {
    // Lookup unlocks the item it finds.
    read(service, account) {
      const value = withAttributes(service, account, (table) =>
        call((error) => libsecret.secret_service_lookup_sync(null, null, table, null, error)),
      );
      if (!value) return;
      try {
        const length = Buffer.alloc(8);
        const data = libsecret.secret_value_get(value, length);
        const size = Number(length.readBigUInt64LE());
        return size ? toBuffer(data, size, true).toString("utf8") : "";
      } finally {
        libsecret.secret_value_unref(value);
      }
    },

    write(service, account, secret) {
      const data = Buffer.from(secret);
      const value = libsecret.secret_value_new(data, BigInt(data.length), "text/plain");
      try {
        withAttributes(service, account, (table) =>
          call((error) =>
            libsecret.secret_service_store_sync(
              null,
              null,
              table,
              null,
              `${service} for ${account}`,
              value,
              null,
              error,
            ),
          ),
        );
      } catch (error) {
        // Without a desktop session the provider cannot ask to create or unlock the default
        // keyring, and saving fails.
        if (!(error instanceof Error) || error.message === NO_SERVICE) throw error;
        throw new Error(
          `${error.message}; unlock or create the default keyring, or use login --insecure-storage`,
          { cause: error },
        );
      } finally {
        libsecret.secret_value_unref(value);
      }
    },

    // Clear skips locked items, so delete unlocks every match and deletes each one. A provider
    // can also ask before it deletes, and libsecret reports a dismissed prompt as success, so
    // delete searches again afterwards.
    delete(service, account) {
      each(service, account, SEARCH_ALL | SEARCH_UNLOCK, (item) => {
        if (libsecret.secret_item_get_locked(item))
          throw new Error("Secret Service: the item is still locked");
        call((error) => libsecret.secret_item_delete_sync(item, null, error));
      });
      each(service, account, SEARCH_ALL, () => {
        throw new Error("Secret Service: the item was not deleted");
      });
    },
  };
}
