// Patches tcpip 0.4.0 after install. The WASM is rebuilt by build.sh from
// lwip-glue.patch; the JavaScript fixes are applied to the bundled dist below.
import fs from "node:fs";

const directory = "node_modules/tcpip";
const { version } = JSON.parse(fs.readFileSync(`${directory}/package.json`, "utf8"));
if (version !== "0.4.0") throw new Error(`Review the tcpip patches for version ${version}`);

fs.copyFileSync(new URL("tcpip.wasm", import.meta.url), `${directory}/tcpip.wasm`);

const fixes = [
  {
    // A remote half-close must not error the local writable side.
    name: "half-close",
    count: 2,
    broken: /this\.#o\(\),this\.#r\?\.error\(new Error\("tcp connection closed"\)\)/g,
    fixed: () => "this.#o()",
    applied: () => 2,
  },
  {
    // Packets copied into WASM memory for lwIP were never freed.
    name: "tun packet free",
    count: 1,
    broken:
      /sendPacket:(\w+)=>\{let (\w+)=this\.copyToMemory\(\1\);this\.exports\.send_tun_interface\((\w+),\2,\1\.length\)\}/g,
    fixed: (_, packet, pointer, handle) =>
      `sendPacket:${packet}=>{let ${pointer}=this.copyToMemory(${packet});try{this.exports.send_tun_interface(${handle},${pointer},${packet}.length)}finally{this.exports.free(Number(${pointer}))}}`,
    applied: (source) => source.match(/try\{this\.exports\.send_tun_interface/g)?.length,
  },
  {
    // Data copied into WASM memory for tcp_write, which copies it again, was never freed.
    name: "tcp send free",
    count: 2,
    broken:
      /send:async (\w+)=>\{let (\w+)=Number\(this\.copyToMemory\(\1\)\),(\w+=this\.exports\.send_tcp_chunk\(\w+,\2,\1\.length\);for\(;[^{}]*\{await new Promise\([^{}]*\{[^{}]*\}\);[^{}]*\})\}/g,
    fixed: (_, data, pointer, body) =>
      `send:async ${data}=>{let ${pointer}=Number(this.copyToMemory(${data}));try{let ${body}}finally{this.exports.free(${pointer})}}`,
    applied: (source) => source.match(/try\{let \w+=this\.exports\.send_tcp_chunk/g)?.length,
  },
];

const file = `${directory}/dist/index.js`;
let source = fs.readFileSync(file, "utf8");
for (const { applied, broken, count, fixed, name } of fixes) {
  const matches = source.match(broken)?.length ?? 0;
  if (matches === 0 && applied(source) === count) continue;
  if (matches !== count)
    throw new Error(`tcpip ${name} patch matched ${matches} times, expected ${count}`);
  source = source.replace(broken, fixed);
}
fs.writeFileSync(file, source);
