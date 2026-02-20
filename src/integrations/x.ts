import axios, { AxiosError } from "axios";
import crypto from "crypto";

const DEFAULT_API_BASE_URL = "https://api.x.com";

export interface XApiCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

export interface PostTweetInput {
  text: string;
  replyToTweetId?: string | null;
}

export interface PostTweetResult {
  id: string;
  text: string;
}

export interface XCurrentUser {
  id: string;
  username: string | null;
  name: string | null;
}

export class XClient {
  private readonly apiBaseUrl: string;

  constructor(private readonly credentials: XApiCredentials, apiBaseUrl: string = DEFAULT_API_BASE_URL) {
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/g, "");
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): XClient {
    const apiKey = firstNonEmpty(env.X_API_KEY, env.TWITTER_API_KEY);
    const apiSecret = firstNonEmpty(env.X_API_SECRET, env.TWITTER_API_SECRET);
    const accessToken = firstNonEmpty(env.X_ACCESS_TOKEN, env.TWITTER_ACCESS_TOKEN);
    const accessTokenSecret = firstNonEmpty(env.X_ACCESS_TOKEN_SECRET, env.TWITTER_ACCESS_TOKEN_SECRET);

    const missing: string[] = [];
    if (!apiKey) {
      missing.push("X_API_KEY");
    }
    if (!apiSecret) {
      missing.push("X_API_SECRET");
    }
    if (!accessToken) {
      missing.push("X_ACCESS_TOKEN");
    }
    if (!accessTokenSecret) {
      missing.push("X_ACCESS_TOKEN_SECRET");
    }

    if (missing.length > 0) {
      throw new Error(`Missing required X credentials: ${missing.join(", ")}`);
    }

    return new XClient(
      {
        apiKey: apiKey as string,
        apiSecret: apiSecret as string,
        accessToken: accessToken as string,
        accessTokenSecret: accessTokenSecret as string,
      },
      env.X_API_BASE_URL ?? DEFAULT_API_BASE_URL
    );
  }

  async postTweet(input: PostTweetInput): Promise<PostTweetResult> {
    const url = `${this.apiBaseUrl}/2/tweets`;

    const payload: Record<string, unknown> = {
      text: input.text,
    };

    if (input.replyToTweetId) {
      payload.reply = {
        in_reply_to_tweet_id: input.replyToTweetId,
      };
    }

    const authorization = buildOauthHeader("POST", url, this.credentials);

    try {
      const response = await axios.post(url, payload, {
        timeout: 20_000,
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          "User-Agent": "ncaabsb-x-feed/1.0",
        },
      });

      const id = String(response.data?.data?.id ?? "").trim();
      const text = String(response.data?.data?.text ?? "");

      if (!id) {
        throw new Error("X response did not include a tweet id.");
      }

      return {
        id,
        text: text || input.text,
      };
    } catch (error) {
      throw new Error(formatXApiError(error));
    }
  }

  async getCurrentUser(): Promise<XCurrentUser> {
    const url = `${this.apiBaseUrl}/2/users/me`;
    const authorization = buildOauthHeader("GET", url, this.credentials);

    try {
      const response = await axios.get(url, {
        timeout: 20_000,
        headers: {
          Authorization: authorization,
          "User-Agent": "ncaabsb-x-feed/1.0",
        },
      });

      const id = String(response.data?.data?.id ?? "").trim();
      if (!id) {
        throw new Error("X response did not include user id.");
      }

      const username = toNullableString(response.data?.data?.username);
      const name = toNullableString(response.data?.data?.name);

      return {
        id,
        username,
        name,
      };
    } catch (error) {
      throw new Error(formatXApiError(error));
    }
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function toNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function buildOauthHeader(method: string, requestUrl: string, credentials: XApiCredentials): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: credentials.apiKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: credentials.accessToken,
    oauth_version: "1.0",
  };

  const signature = buildSignature(method, requestUrl, oauthParams, credentials);
  oauthParams.oauth_signature = signature;

  const header = Object.keys(oauthParams)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(oauthParams[key])}"`)
    .join(", ");

  return `OAuth ${header}`;
}

function buildSignature(
  method: string,
  requestUrl: string,
  oauthParams: Record<string, string>,
  credentials: XApiCredentials
): string {
  const url = new URL(requestUrl);
  const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;

  const allParams: Array<[string, string]> = [];

  url.searchParams.forEach((value, key) => {
    allParams.push([key, value]);
  });

  Object.entries(oauthParams).forEach(([key, value]) => {
    allParams.push([key, value]);
  });

  allParams.sort((a, b) => {
    const keyA = percentEncode(a[0]);
    const keyB = percentEncode(b[0]);
    if (keyA !== keyB) {
      return keyA < keyB ? -1 : 1;
    }

    const valueA = percentEncode(a[1]);
    const valueB = percentEncode(b[1]);
    if (valueA === valueB) {
      return 0;
    }

    return valueA < valueB ? -1 : 1;
  });

  const parameterString = allParams
    .map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`)
    .join("&");

  const baseString = [method.toUpperCase(), percentEncode(baseUrl), percentEncode(parameterString)].join("&");
  const signingKey = `${percentEncode(credentials.apiSecret)}&${percentEncode(credentials.accessTokenSecret)}`;

  return crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");
}

function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/!/g, "%21")
    .replace(/\*/g, "%2A")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

function formatXApiError(error: unknown): string {
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    const data = error.response?.data;
    const detail =
      typeof data === "string"
        ? data
        : JSON.stringify(data ?? {});

    if (status) {
      return `X API request failed (${status}): ${detail}`;
    }

    return `X API request failed: ${error.message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
