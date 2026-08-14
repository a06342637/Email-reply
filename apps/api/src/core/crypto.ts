import { Injectable } from "@nestjs/common";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import sodium from "libsodium-wrappers-sumo";
import { AppConfig } from "./config.js";

type Envelope = { v: 1; n: string; c: string };

@Injectable()
export class CryptoService {
  private readonly key: Uint8Array;

  constructor(private readonly config: AppConfig) {
    this.key = Buffer.from(config.instanceKey, "base64");
  }

  async encryptString(value: string, context = "generic"): Promise<string> {
    await sodium.ready;
    const nonce = randomBytes(
      sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
    );
    const cipher = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      Buffer.from(value, "utf8"),
      Buffer.from(context, "utf8"),
      null,
      nonce,
      this.key,
    );
    const envelope: Envelope = {
      v: 1,
      n: Buffer.from(nonce).toString("base64url"),
      c: Buffer.from(cipher).toString("base64url"),
    };
    return Buffer.from(JSON.stringify(envelope)).toString("base64url");
  }

  async decryptString(encrypted: string, context = "generic"): Promise<string> {
    await sodium.ready;
    const envelope = JSON.parse(
      Buffer.from(encrypted, "base64url").toString("utf8"),
    ) as Envelope;
    if (envelope.v !== 1)
      throw new Error("Unsupported encrypted envelope version");
    const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      Buffer.from(envelope.c, "base64url"),
      Buffer.from(context, "utf8"),
      Buffer.from(envelope.n, "base64url"),
      this.key,
    );
    return Buffer.from(plain).toString("utf8");
  }

  hash(value: string): string {
    return createHash("sha256").update(value).digest("base64url");
  }

  hmac(value: string): string {
    return createHmac("sha256", this.config.sessionSecret)
      .update(value)
      .digest("base64url");
  }

  safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString("base64url");
  }
}
