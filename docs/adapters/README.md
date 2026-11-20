# Writing an adapter

An adapter teaches `openenlink login` one sign-in page: how to recognise it, which form to post, and what a rejected sign-in looks like. Everything around it is shared: following redirects, keeping cookies, prompting, reading the gateway's tokens and `--remember`.

Without an adapter, a gateway still works through the browser sign-in. An adapter adds the terminal sign-in and, with it, `--remember`.

## Study the sign-in page

Sign in once in a browser with the developer tools open on the Network tab, starting from the address `openenlink login` prints. Write down:

- the address of the page that shows the username and password fields, and something in its HTML that only this page has;
- the request the page sends on submit: its address and every field, the hidden ones included;
- the cookies that keep you signed in, so a second visit skips the password;
- what the server returns after a wrong password;
- when a captcha appears, and where its image comes from.

## Write the adapter

Create `src/adapters/<name>.ts` and export an `Adapter` from `src/adapter.ts`:

```ts
export type Adapter = {
  session: string[];
  form: (page: Page, web: Web) => LoginForm | undefined;
  failure: (page: Page) => Failure;
};
```

`form` receives the first page the sign-in lands on. It returns nothing for a page of another site, so check the path and a marker in the HTML first. For its own page it returns a `LoginForm`:

```ts
export type LoginForm = {
  action: URL;
  body: (account: Account, captcha?: string) => URLSearchParams;
  captcha?: () => Promise<Buffer>;
};
```

`action` is where the form is posted, and `body` builds the posted fields from the typed username and password. Set `captcha` only when the page asks for one; it returns the image as JPEG bytes. `tags` in `src/web.ts` reads the attributes of every start tag of one name, which covers hidden inputs, and `web.json` fetches a JSON endpoint with the sign-in's cookies.

When the page is yours and its fields differ from what the adapter knows, throw `UnsupportedLogin`. `login` then moves to the browser before it asks for a password.

`failure` receives the page returned after a rejected post and classifies it:

| `reason`   | Effect                                                |
| ---------- | ----------------------------------------------------- |
| `password` | `login` asks for the username and password again.     |
| `captcha`  | `login` reads the form again and shows a new captcha. |
| `other`    | `login` stops and prints `message`.                   |

Pass server text through `printable` before putting it in `message`.

`session` names the cookies that keep the sign-in session. `--remember` saves them and sends them again before it falls back to the password.

[`src/adapters/suda.ts`](../../src/adapters/suda.ts) is a complete adapter to copy from.

## Register it

Add the adapter to `ADAPTERS` in `src/login.ts`. `login` asks each adapter in order and uses the first whose `form` returns a form.

## Test it

`test/login.test.ts` starts one HTTPS server that plays both the gateway and a sign-in page. Add a sign-in page for your adapter there, built from the HTML and responses you wrote down, and cover:

- a successful sign-in, with the exact fields posted;
- a wrong password;
- a captcha, when the page has one;
- a page whose fields changed;
- a second sign-in with the session cookies alone.

Then sign in against the real gateway once yourself. Keep real usernames, passwords, cookies and tokens out of tests, fixtures and commit messages.

## Document it

Write `docs/adapters/<name>.md` and `docs/adapters/<name>.zh-CN.md`, following [suda.md](suda.md): the gateway address, a first run, what the terminal sign-in supports, and the sign-in flow you wrote down. Add a row to the adapter table in `README.md` and `README.zh-CN.md`.
