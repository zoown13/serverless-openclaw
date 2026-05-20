import type {
  AssistantToolCapability,
  ToolCapabilityDefinition,
  ToolCapabilityId,
  ToolRuntimeProvider,
} from "./types.js";

const GMAIL_CAPABILITY_IDS = new Set<ToolCapabilityId>([
  "gmail_payment",
  "gmail_search",
  "gmail_body_selection",
]);

export const TOOL_CAPABILITY_REGISTRY: readonly ToolCapabilityDefinition[] = [
  {
    id: "gmail_payment",
    family: "gmail",
    displayName: "Gmail payment summary",
    description:
      "Summarize payment, receipt, card spending, and statement data from Gmail using headers/snippets first.",
    dataSensitivity: "user_private",
    readOnly: true,
    examples: [
      "이번주 결제한 금액 얼마야?",
      "카드사별 결제 내역 보여줘",
      "일본 여행 관련 결제만 정리해줘",
    ],
    safety: {
      headersFirst: true,
      maxDisplayedItems: 5,
      noAttachments: true,
      mutationAllowed: false,
    },
  },
  {
    id: "gmail_search",
    family: "gmail",
    displayName: "Gmail search",
    description:
      "Search Gmail messages with bounded metadata/snippet retrieval and controlled body access.",
    dataSensitivity: "user_private",
    readOnly: true,
    examples: [
      "지메일에서 항공권 메일 찾아줘",
      "최근 네이버페이 메일 검색해줘",
    ],
    safety: {
      headersFirst: true,
      maxDisplayedItems: 5,
      noAttachments: true,
      mutationAllowed: false,
    },
  },
  {
    id: "gmail_body_selection",
    family: "gmail",
    displayName: "Gmail body selection",
    description:
      "Open one explicitly selected Gmail message body with a bounded character budget.",
    dataSensitivity: "user_private",
    readOnly: true,
    examples: [
      "2번 메일 본문 열어줘",
      "첫 번째 영수증 자세히 봐줘",
    ],
    safety: {
      headersFirst: false,
      maxDisplayedItems: 1,
      noAttachments: true,
      mutationAllowed: false,
    },
  },
  {
    id: "aws_cost_lookup",
    family: "cloud_billing",
    displayName: "AWS cost lookup",
    description:
      "Read AWS Cost Explorer data for monthly totals, service breakdowns, and recent cost trends.",
    dataSensitivity: "account_private",
    readOnly: true,
    examples: [
      "이번달 AWS 비용 얼마야?",
      "서비스별 AWS 요금 보여줘",
      "최근 7일 AWS 비용 추이 알려줘",
    ],
    safety: {
      headersFirst: false,
      cacheTtlSeconds: 900,
      noAttachments: true,
      mutationAllowed: false,
    },
  },
];

export interface BuildAssistantToolCapabilitiesOptions {
  toolRuntimeProvider: ToolRuntimeProvider;
  gmailAvailable: boolean;
  awsCostLookupAvailable?: boolean;
}

export function buildAssistantToolCapabilities(
  options: BuildAssistantToolCapabilitiesOptions,
): AssistantToolCapability[] {
  return TOOL_CAPABILITY_REGISTRY.map((definition) => {
    if (GMAIL_CAPABILITY_IDS.has(definition.id)) {
      return {
        ...definition,
        status: options.gmailAvailable ? "available" : "disabled",
        executionRuntime: options.toolRuntimeProvider,
        ...(options.gmailAvailable
          ? {}
          : { unavailableReason: "Gmail is not ready in the delegated tool runtime." }),
      };
    }

    if (definition.id === "aws_cost_lookup") {
      return {
        ...definition,
        status: options.awsCostLookupAvailable === true ? "available" : "planned",
        executionRuntime: options.toolRuntimeProvider,
        ...(options.awsCostLookupAvailable === true
          ? {}
          : { unavailableReason: "Cost Explorer handler and IAM policy are not enabled yet." }),
      };
    }

    return {
      ...definition,
      status: "planned",
      executionRuntime: options.toolRuntimeProvider,
    };
  });
}
