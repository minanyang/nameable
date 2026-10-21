import { connect } from "node:net";
import type { Whois } from "./types.js";

/**
 * Plain whois over TCP port 43. The only code that opens a socket: unit tests inject a fake whois,
 * and the contract and live tests cover this.
 */
export const tcpWhois: Whois = (server, query) =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ host: server, port: 43 }, () => {
      socket.write(`${query}\r\n`);
    });
    // A deadline for the whole answer, not an idle timeout, which a server sending a byte at a time
    // would never trigger.
    const deadline = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error(`whois ${server} timed out`), { name: "TimeoutError" }));
    }, 10_000);
    socket.on("close", () => clearTimeout(deadline));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
