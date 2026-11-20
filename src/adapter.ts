// The contract between the terminal sign-in and one identity provider. Each provider's adapter
// lives in src/adapters/ and recognises its own sign-in page.

import { AuthenticationError } from "./controller.ts";
import type { Page, Web } from "./web.ts";

export type Account = { username: string; password: string };

export type LoginForm = {
  action: URL;
  body: (account: Account, captcha?: string) => URLSearchParams;
  // Present when the page asks for a captcha; returns the image to show.
  captcha?: () => Promise<Buffer>;
};

export type Failure = { reason: "password" | "captcha" | "other"; message: string };

export type Adapter = {
  // Cookies that keep the provider's sign-in session; sent again, they skip the password.
  session: string[];
  // Reads the sign-in form of a page from this adapter's provider, or returns nothing for any
  // other page. A page that looks like the provider's but carries unexpected fields throws
  // UnsupportedLogin before any password is asked for.
  form: (page: Page, web: Web) => LoginForm | undefined;
  // Explains the page shown after a rejected sign-in.
  failure: (page: Page) => Failure;
};

// The terminal cannot finish this sign-in; a browser can.
export class UnsupportedLogin extends AuthenticationError {}
