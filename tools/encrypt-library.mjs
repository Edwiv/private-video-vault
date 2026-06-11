import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const [, , sourcePath, targetPath] = process.argv;

if (!sourcePath || !targetPath) {
  console.error("Usage: node tools/encrypt-library.mjs <library.json> <library.enc.json>");
  process.exit(1);
}

const passphrase = process.env.VIDEO_VAULT_PASSPHRASE || (await askHidden("Master key: "));

if (!passphrase) {
  console.error("Master key is required.");
  process.exit(1);
}

const plaintext = await readFile(sourcePath);
JSON.parse(plaintext.toString("utf8"));

const salt = randomBytes(16);
const iv = randomBytes(12);
const iterations = 310000;
const key = pbkdf2Sync(passphrase, salt, iterations, 32, "sha256");
const cipher = createCipheriv("aes-256-gcm", key, iv);
const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const tag = cipher.getAuthTag();

const envelope = {
  version: 1,
  cipher: "AES-GCM",
  kdf: {
    name: "PBKDF2",
    hash: "SHA-256",
    iterations,
    salt: salt.toString("base64"),
  },
  iv: iv.toString("base64"),
  data: Buffer.concat([encrypted, tag]).toString("base64"),
};

await writeFile(targetPath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
console.log(`Encrypted library written to ${targetPath}`);

async function askHidden(query) {
  if (!input.isTTY) {
    return "";
  }

  const rl = createInterface({ input, output });
  const originalWrite = output.write;
  output.write = function writeHidden(text, encoding, callback) {
    if (text.includes(query)) {
      return originalWrite.call(output, text, encoding, callback);
    }
    return true;
  };

  try {
    const answer = await rl.question(query);
    originalWrite.call(output, "\n");
    return answer;
  } finally {
    output.write = originalWrite;
    rl.close();
  }
}
