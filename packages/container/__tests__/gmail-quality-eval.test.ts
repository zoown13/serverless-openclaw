import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailTokenBudgetPolicy } from "@serverless-openclaw/shared";

const { decideToolIntentMock, parseToolIntentAdvisorResponseMock } = vi.hoisted(() => ({
  decideToolIntentMock: vi.fn(),
  parseToolIntentAdvisorResponseMock: vi.fn(),
}));

vi.mock("../src/tool-intent-advisor.js", () => ({
  decideToolIntent: decideToolIntentMock,
  parseToolIntentAdvisorResponse: parseToolIntentAdvisorResponseMock,
}));

import { maybeHandleCustomGmailRequest } from "../src/gmail-tool.js";

const EMAIL_BUDGET: EmailTokenBudgetPolicy = {
  mode: "headers-first",
  maxMessages: 5,
  paymentScanMessages: 25,
  maxSnippetChars: 120,
  maxBodyChars: 80,
  requireExplicitBodyAccess: true,
};

interface EvalDataset {
  cases: EvalCase[];
}

interface EvalCase {
  id: string;
  steps: EvalStep[];
}

interface EvalStep {
  message: string;
  listResults?: string[][];
  messages?: EvalMessage[];
  fullBodies?: Array<{ id: string; body: string }>;
  expectIncludes?: string[];
  expectExcludes?: string[];
  expectNoAdditionalFetch?: boolean;
}

interface EvalMessage {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

function metadataResponse(message: EvalMessage) {
  return jsonResponse({
    id: message.id,
    threadId: `${message.id}-thread`,
    snippet: message.snippet,
    payload: {
      headers: [
        { name: "Subject", value: message.subject },
        { name: "From", value: message.from },
        { name: "Date", value: message.date },
      ],
    },
  });
}

function fullBodyResponse(id: string, bodyText: string) {
  return jsonResponse({
    id,
    threadId: `${id}-thread`,
    payload: {
      headers: [
        { name: "Subject", value: "결제 상세" },
        { name: "From", value: "billing@example.com" },
        { name: "Date", value: "Tue, 31 Mar 2026 09:00:00 +0000" },
      ],
      mimeType: "text/plain",
      body: {
        data: Buffer.from(bodyText, "utf-8").toString("base64url"),
      },
    },
  });
}

function loadEvalDataset(): EvalDataset {
  const fixturePath = path.join(
    __dirname,
    "fixtures",
    "gmail-quality-eval.json",
  );
  return JSON.parse(fs.readFileSync(fixturePath, "utf8")) as EvalDataset;
}

describe("gmail quality evaluation set", () => {
  let tempHomeDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  const dataset = loadEvalDataset();

  beforeEach(() => {
    tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-quality-eval-"));
    process.env.HOME = tempHomeDir;
    process.env.USERPROFILE = tempHomeDir;
    fs.mkdirSync(path.join(tempHomeDir, ".openclaw", "credentials"), { recursive: true });
    fs.mkdirSync(path.join(tempHomeDir, ".config", "gogcli"), { recursive: true });
    fs.writeFileSync(
      path.join(tempHomeDir, ".openclaw", "credentials", "oauth.json"),
      JSON.stringify({ email: "zoown13@gmail.com", refresh_token: "refresh-token-value" }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tempHomeDir, ".config", "gogcli", "credentials.json"),
      JSON.stringify({
        installed: {
          client_id: "client-id",
          client_secret: "client-secret",
        },
      }),
      "utf-8",
    );

    decideToolIntentMock.mockReset();
    decideToolIntentMock.mockResolvedValue(null);
    parseToolIntentAdvisorResponseMock.mockReset();

    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
  });

  it("maintains at least 80% pass coverage across the curated travel/payment evaluation set", async () => {
    const failures: string[] = [];
    let passedCases = 0;

    for (const evalCase of dataset.cases) {
      let lastRendered = "";
      try {
        for (const [stepIndex, step] of evalCase.steps.entries()) {
          if (stepIndex === 0) {
            fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: "access-token" }));
            for (const ids of step.listResults ?? []) {
              fetchMock.mockResolvedValueOnce(
                jsonResponse({
                  messages: ids.map((id) => ({ id })),
                }),
              );
            }
            for (const message of step.messages ?? []) {
              fetchMock.mockResolvedValueOnce(metadataResponse(message));
            }
            for (const fullBody of step.fullBodies ?? []) {
              fetchMock.mockResolvedValueOnce(fullBodyResponse(fullBody.id, fullBody.body));
            }
          }

          const fetchCallsBefore = fetchMock.mock.calls.length;
          const response = await maybeHandleCustomGmailRequest({
            userId: `eval-${evalCase.id}`,
            sessionKey: `session-${evalCase.id}`,
            message: step.message,
            gmailReady: true,
            emailTokenBudget: EMAIL_BUDGET,
          });

          expect(response?.kind).toBe("direct");

          const rendered = response?.message ?? "";
          lastRendered = rendered;
          for (const expected of step.expectIncludes ?? []) {
            expect(rendered).toContain(expected);
          }
          for (const unexpected of step.expectExcludes ?? []) {
            expect(rendered).not.toContain(unexpected);
          }
          if (step.expectNoAdditionalFetch) {
            expect(fetchMock.mock.calls.length).toBe(fetchCallsBefore);
          }
        }

        passedCases += 1;
      } catch (error) {
        failures.push(
          `${evalCase.id}: ${error instanceof Error ? error.message : String(error)} | rendered=${JSON.stringify(lastRendered.slice(0, 240))}`,
        );
      }
    }

    const passRatio = passedCases / dataset.cases.length;
    expect({ passedCases, totalCases: dataset.cases.length }).toMatchObject({
      passedCases: expect.any(Number),
      totalCases: dataset.cases.length,
    });
    if (passRatio < 0.8) {
      throw new Error(
        `travel/payment eval ratio ${passRatio.toFixed(2)} below target: ${failures.join(" | ")}`,
      );
    }
  });
});
