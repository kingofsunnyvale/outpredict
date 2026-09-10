export type VerifiedUser = { id: string; name: string; email: string };

export type Source = {
  id: string;
  kind: "profile" | "official" | "web" | "attachment" | "calculation";
  title: string;
  url?: string;
  excerpt?: string;
  observedAt?: string;
  applicantId?: string;
  profileId?: string;
  attachmentId?: string;
};

export type CohortStats = {
  totalProfiles: number;
  matchedProfiles: number;
  examinedProfiles: number;
  supportingProfiles: number;
  profilesWithOutcomes: number;
  filters: Record<string, string | number | boolean | null>;
  limitations: string[];
  statistics?: Record<string, unknown>;
  coverage?: { sources: string[]; cycles: string[] };
};

export type Evidence = {
  sources: Source[];
  cohort?: CohortStats;
  notes?: string[];
};

export type MessageStatus =
  | "pending"
  | "running"
  | "complete"
  | "cancelled"
  | "failed";

export type Chat = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  generationId: string | null;
  deletionPending?: boolean;
};

export type Message = {
  id: string;
  chatId: string;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  requestId: string | null;
  replyToId: string | null;
  evidence: Evidence | null;
  createdAt: number;
  updatedAt: number;
};

export type Attachment = {
  id: string;
  chatId: string | null;
  messageId: string | null;
  name: string;
  type: string;
  size: number;
  status: "processing" | "ready" | "failed";
  error: string | null;
  createdAt: number;
};

export class ProductError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string = "request_failed",
  ) {
    super(message);
    this.name = "ProductError";
  }
}

export const PRODUCT_LIMITS = {
  fileBytes: 8 * 1024 * 1024,
  storageBytes: 64 * 1024 * 1024,
  filesPerUser: 40,
  attachmentsPerMessage: 4,
  chatsPerUser: 100,
  messagesPerChat: 200,
  requestsPerDay: 50,
  conversionRequestsPerDay: 20,
  messageCharacters: 20_000,
  extractedCharacters: 80_000,
  generationLeaseMs: 180_000,
} as const;
