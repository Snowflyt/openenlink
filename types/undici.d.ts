// undici's index loads the whole library, about 200 ms on Windows, and openenlink needs only the
// Agent. The file is internal to undici, so package.json pins the version. It exports the class
// as module.exports, which is the default export here.
declare module "undici/lib/dispatcher/agent.js" {
  import { Agent } from "undici";
  export default Agent;
}
