import { createCipheriv, createDecipheriv, createHmac, pbkdf2, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import * as plist from "plist";

// OmniFileStore encryption, as specified by Omni's own reference implementation:
// https://github.com/omnigroup/OmniGroup/blob/main/Frameworks/OmniFileStore/EncryptionFormat.md
// https://github.com/omnigroup/OmniGroup/blob/main/Frameworks/OmniFileStore/DecryptionExample.py

const FILE_MAGIC = Buffer.from("OmniFileEncryption\x00\x00", "latin1");
const SEG_IV_LEN = 12;
const SEG_MAC_LEN = 20;
const SEG_PAGE_SIZE = 65536;
const SEG_HEADER_LEN = SEG_IV_LEN + SEG_MAC_LEN;
const FILE_MAC_PREFIX = Buffer.from([0x01]);
const FILE_MAC_LEN = 32;
const KEYWRAP_IV = Buffer.from("A6A6A6A6A6A6A6A6", "hex");

enum SlotType {
  None = 0,
  ActiveAESWRAP = 1,
  RetiredAESWRAP = 2,
  ActiveAES_CTR_HMAC = 3,
  RetiredAES_CTR_HMAC = 4,
  PlaintextMask = 5,
  RetiredPlaintextMask = 6,
}

interface Slot {
  type: SlotType;
  id: number;
  contents: Buffer;
}

function keyUnwrap(kek: Buffer, wrapped: Buffer): Buffer {
  const decipher = createDecipheriv(`id-aes${kek.length * 8}-wrap`, kek, KEYWRAP_IV);
  return Buffer.concat([decipher.update(wrapped), decipher.final()]);
}

function hmac(key: Buffer, ...parts: Buffer[]): Buffer {
  const h = createHmac("sha256", key);
  for (const p of parts) h.update(p);
  return h.digest();
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/** AES-128-CTR, with the 12-byte segment IV followed by a zero 32-bit counter. */
function ctr(key: Buffer, iv: Buffer, data: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ctr", key, Buffer.concat([iv, Buffer.alloc(4)]));
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/** The document keys for an encrypted OmniFocus database, unlocked with its passphrase. */
export class DocumentKey {
  private constructor(private slots: Slot[]) {}

  /** Unlocks the `encrypted` metadata file at the root of the database. */
  static async unlock(metadataFile: Buffer, passphrase: string): Promise<DocumentKey> {
    let metadata = plist.parse(metadataFile.toString("utf8")) as unknown;
    // Current versions store a 1-element array of dictionaries.
    if (Array.isArray(metadata)) metadata = metadata[0];
    const m = metadata as Record<string, unknown>;
    if (m.method !== "password" || m.algorithm !== "PBKDF2; aes128-wrap")
      throw new Error(`Unsupported OmniFocus key derivation: ${m.method} / ${m.algorithm}`);

    const prf = (m.prf as string | undefined) ?? "sha1";
    if (!["sha1", "sha256", "sha512"].includes(prf)) throw new Error(`Unsupported OmniFocus PRF: ${prf}`);
    // OFSDocumentKey.m derives an AES-256 key for SHA-256 and up, and AES-128 otherwise.
    const kek = await promisify(pbkdf2)(
      Buffer.from(passphrase.normalize("NFC"), "utf8"),
      Buffer.from(m.salt as Uint8Array),
      Number(m.rounds),
      prf === "sha1" ? 16 : 32,
      prf,
    );

    let unwrapped: Buffer;
    try {
      unwrapped = keyUnwrap(kek, Buffer.from(m.key as Uint8Array));
    } catch {
      throw new Error("Couldn't unlock the OmniFocus database; the encryption passphrase is wrong.");
    }

    const slots: Slot[] = [];
    for (let i = 0; i < unwrapped.length; ) {
      const type = unwrapped[i];
      if (type === SlotType.None) break; // Trailing padding
      const length = 4 * unwrapped[i + 1];
      slots.push({ type, id: unwrapped.readUInt16BE(i + 2), contents: unwrapped.subarray(i + 4, i + 4 + length) });
      i += 4 + length;
    }
    return new DocumentKey(slots);
  }

  /** Whether the database's policy stores files with this name unencrypted (e.g. `.client` files). */
  private plaintextPolicy(filename: string): SlotType.PlaintextMask | SlotType.RetiredPlaintextMask | null {
    let policy: SlotType.PlaintextMask | SlotType.RetiredPlaintextMask | null = null;
    for (const slot of this.slots) {
      if (slot.type !== SlotType.PlaintextMask && slot.type !== SlotType.RetiredPlaintextMask) continue;
      const end = slot.contents.indexOf(0);
      const suffix = slot.contents.subarray(0, end === -1 ? undefined : end).toString("utf8");
      if (filename.endsWith(suffix) && policy !== SlotType.PlaintextMask) policy = slot.type;
    }
    return policy;
  }

  private fileKey(info: Buffer): Buffer {
    const id = info.readUInt16BE(0);
    const slot = this.slots.find((s) => s.id === id);
    if (!slot) throw new Error(`OmniFocus file uses unknown key ${id}.`);
    if (slot.type === SlotType.ActiveAES_CTR_HMAC || slot.type === SlotType.RetiredAES_CTR_HMAC) return slot.contents;
    if (slot.type === SlotType.ActiveAESWRAP || slot.type === SlotType.RetiredAESWRAP)
      return keyUnwrap(slot.contents, info.subarray(2));
    throw new Error(`OmniFocus file uses key ${id}, which is not an encryption key.`);
  }

  decrypt(filename: string, data: Buffer): Buffer {
    if (!data.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) {
      if (this.plaintextPolicy(filename) && !data.subarray(0, FILE_MAGIC.length).includes("crypt")) return data;
      throw new Error(`${filename} is not encrypted, and the database doesn't allow that.`);
    }

    const infoLength = data.readUInt16BE(FILE_MAGIC.length);
    const infoStart = FILE_MAGIC.length + 2;
    const key = this.fileKey(data.subarray(infoStart, infoStart + infoLength));
    const [aesKey, macKey] = [key.subarray(0, 16), key.subarray(16, 32)];

    const segmentsStart = Math.ceil((infoStart + infoLength) / 16) * 16;
    const segmentsEnd = data.length - FILE_MAC_LEN;
    if (segmentsEnd < segmentsStart) throw new Error(`${filename} is truncated.`);

    const fileMac = createHmac("sha256", macKey).update(FILE_MAC_PREFIX);
    const plaintext: Buffer[] = [];
    for (let index = 0, pos = segmentsStart; pos < segmentsEnd; index++) {
      const dataStart = pos + SEG_HEADER_LEN;
      const dataEnd = Math.min(dataStart + SEG_PAGE_SIZE, segmentsEnd);
      if (dataStart > segmentsEnd) throw new Error(`${filename} is truncated.`);
      const iv = data.subarray(pos, pos + SEG_IV_LEN);
      const mac = data.subarray(pos + SEG_IV_LEN, dataStart);
      const ciphertext = data.subarray(dataStart, dataEnd);
      const expected = hmac(macKey, iv, u32(index), ciphertext).subarray(0, SEG_MAC_LEN);
      if (!timingSafeEqual(expected, mac)) throw new Error(`${filename} failed its integrity check.`);
      fileMac.update(mac);
      plaintext.push(ctr(aesKey, iv, ciphertext));
      pos = dataEnd;
    }
    if (!timingSafeEqual(fileMac.digest(), data.subarray(segmentsEnd)))
      throw new Error(`${filename} failed its integrity check.`);
    return Buffer.concat(plaintext);
  }

  encrypt(filename: string, data: Buffer): Buffer {
    if (this.plaintextPolicy(filename) === SlotType.PlaintextMask) return data;
    const slot = this.slots.find((s) => s.type === SlotType.ActiveAES_CTR_HMAC);
    if (!slot) throw new Error("The OmniFocus database has no active encryption key.");
    const [aesKey, macKey] = [slot.contents.subarray(0, 16), slot.contents.subarray(16, 32)];

    const header = Buffer.alloc(Math.ceil((FILE_MAGIC.length + 4) / 16) * 16);
    FILE_MAGIC.copy(header);
    header.writeUInt16BE(2, FILE_MAGIC.length); // Key info length: just the key ID
    header.writeUInt16BE(slot.id, FILE_MAGIC.length + 2);

    const out = [header];
    const fileMac = createHmac("sha256", macKey).update(FILE_MAC_PREFIX);
    // An empty file still gets one (empty) segment.
    for (let index = 0, pos = 0; index === 0 || pos < data.length; index++, pos += SEG_PAGE_SIZE) {
      const iv = randomBytes(SEG_IV_LEN);
      const ciphertext = ctr(aesKey, iv, data.subarray(pos, pos + SEG_PAGE_SIZE));
      const mac = hmac(macKey, iv, u32(index), ciphertext).subarray(0, SEG_MAC_LEN);
      fileMac.update(mac);
      out.push(iv, mac, ciphertext);
    }
    out.push(fileMac.digest());
    return Buffer.concat(out);
  }
}
