import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASEBALL_PRINT_XSL,
  buildStatBroadcastPrintPdfUrl,
  extractStatBroadcastId,
} from "../src/scrapers/statbroadcast-pdf";

describe("statbroadcast pdf helpers", () => {
  it("extracts ids from raw number input and broadcast urls", () => {
    expect(extractStatBroadcastId("635076")).toBe(635076);
    expect(extractStatBroadcastId("https://stats.statbroadcast.com/broadcast/?id=635076")).toBe(635076);
    expect(
      extractStatBroadcastId("https://stats.statbroadcast.com/broadcast/?id=635076&vislive=ucsb")
    ).toBe(635076);
    expect(extractStatBroadcastId("not-a-valid-id")).toBeNull();
  });

  it("builds print pdf urls with expected query params", () => {
    const url = new URL(buildStatBroadcastPrintPdfUrl(635076));
    expect(url.origin + url.pathname).toBe("https://stats.statbroadcast.com/output/print.php");
    expect(url.searchParams.get("id")).toBe("635076");
    expect(url.searchParams.get("xsl")).toBe(DEFAULT_BASEBALL_PRINT_XSL);
    expect(url.searchParams.get("ext")).toBe("1");
    expect(url.searchParams.get("format")).toBe("pdf");
    expect(url.searchParams.get("prompt")).toBe("0");
  });
});
