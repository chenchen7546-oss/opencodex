import { expect, test } from "bun:test";
import { createServer as tlsServer } from "node:tls";
import { createServer as netServer, type Socket } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCertificateAuthority, issueServerLeaf } from "../../src/claude/intercept/local-ca";
import { repoPath } from "../helpers/repo-root";

test("real SMTP over verified TLS sends only one recipient; STARTTLS refusal never sends credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-smtp-wire-"));
  const ca = createCertificateAuthority({ commonName: "OpenCodex SMTP test CA" });
  const leaf = issueServerLeaf(ca, "OpenCodex SMTP test CA", ["127.0.0.1"]);
  const caPath = join(root, "ca.pem"); writeFileSync(caPath, ca.certPem);
  const sockets = new Set<Socket>(), commands: string[] = [];
  let message = "", collecting = false;
  const accept = (socket: Socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    socket.write("220 local.test ESMTP\r\n"); let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString(); let at: number;
      while ((at = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 2);
        if (collecting) { if (line === ".") { collecting = false; socket.write("250 accepted\r\n"); } else message += line + "\r\n"; continue; }
        commands.push(line.split(" ")[0]!);
        if (line.startsWith("EHLO")) socket.write("250-local.test\r\n250 AUTH PLAIN\r\n");
        else if (line.startsWith("AUTH")) socket.write("235 authenticated\r\n");
        else if (line === "DATA") { collecting = true; socket.write("354 continue\r\n"); }
        else if (line === "STARTTLS") socket.write("454 TLS unavailable\r\n");
        else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  };
  const encrypted = tlsServer({ key: leaf.keyPem, cert: leaf.certPem }, accept);
  const plaintext = netServer(accept);
  encrypted.on("tlsClientError", () => {});
  try {
    await new Promise<void>((resolve) => encrypted.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => plaintext.listen(0, "127.0.0.1", resolve));
    const script = `import nodemailer from 'nodemailer';
      const create = nodemailer.createTransport.bind(nodemailer);
      nodemailer.createTransport = (...args) => { const transport = create(...args), send = transport.sendMail.bind(transport);
        transport.sendMail = (...args) => send(...args).catch(error => { console.error(JSON.stringify({ code: error.code, command: error.command, message: error.message })); throw error; }); return transport; };
      const { sendSmtpMail } = await import(${JSON.stringify(repoPath("src/notifications/smtp.ts"))});
      const input = JSON.parse(await Bun.stdin.text()); console.log(await sendSmtpMail(input.settings, input.recipient, [], new AbortController().signal, true));`;
    const run = async (port: number, security: string, trust: boolean) => {
      const child = Bun.spawn([process.execPath, "--eval", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, NODE_EXTRA_CA_CERTS: trust ? caPath : "" } });
      child.stdin.write(JSON.stringify({ settings: { smtp: { host: "127.0.0.1", port, security, username: "sender@example.test", password: "fake-local-secret", from: "sender@example.test" } },
        recipient: { id: "one", address: "recipient@example.test", enabled: true } })); child.stdin.end();
      const [output, diagnostics] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      await child.exited;
      if (trust && security === "tls" && output.trim() !== "sent") throw new Error(`Local fake SMTP failed: ${diagnostics}`);
      return output.trim();
    };
    const tlsPort = (encrypted.address() as { port: number }).port, plainPort = (plaintext.address() as { port: number }).port;
    expect(await run(tlsPort, "tls", true)).toBe("sent");
    expect(commands.filter((command) => command === "RCPT")).toHaveLength(1);
    expect(message).toContain("recipient@example.test"); expect(message).not.toContain("fake-local-secret");
    commands.length = 0;
    expect(await run(tlsPort, "tls", false)).not.toBe("sent"); expect(commands).not.toContain("AUTH");
    commands.length = 0;
    expect(await run(plainPort, "starttls", true)).not.toBe("sent"); expect(commands).not.toContain("AUTH");
  } finally {
    for (const socket of sockets) socket.destroy(); encrypted.close(); plaintext.close(); rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
