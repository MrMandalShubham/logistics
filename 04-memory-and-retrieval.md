# Logistics System — Memory and Retrieval

## 1. Purpose

Memory and retrieval provide operational context to users and AI assistants without turning the system into an unsafe autonomous decision-maker.

## 2. Memory categories

### Transactional memory

Authoritative records such as orders, deliveries, packages, inventory reservations, payments, riders, and status events. Store these in PostgreSQL and never replace them with vector memory.

### Operational memory

Repeated patterns such as a zone’s delivery duration, warehouse processing time, rider availability pattern, and common exception reasons. Store aggregated facts with timestamps and confidence.

### Policy memory

Delivery policies, refund rules, substitution rules, COD limits, service zones, operating hours, and escalation procedures. Store versioned documents and structured policy records.

### Conversation memory

Customer support or planner conversations. Store only what is necessary, with retention rules and access controls.

### Analytical memory

Historical metrics and features for forecasting, delay prediction, and route recommendations. Keep data lineage back to source events.

## 3. Retrieval use cases

- Support agent retrieves an order timeline and relevant policy.
- Operations manager asks why a delivery is delayed.
- Planner retrieves repeated failure patterns for a zone.
- Rider support retrieves instructions for a delivery exception.
- AI assistant explains a dispatch recommendation using current data and policy.

## 4. Retrieval architecture

Use structured query first, semantic retrieval second.

1. Identify the tenant, user, order, zone, or time range.
2. Query authoritative structured tables.
3. Apply permission filters.
4. Retrieve relevant policy or operational documents.
5. Add historical patterns only when relevant.
6. Produce an answer with source references and timestamps.

Do not use vector search to answer exact questions such as order status, payment amount, or inventory quantity.

## 5. Data model

Recommended entities:

- `knowledge_documents`.
- `knowledge_chunks`.
- `knowledge_versions`.
- `knowledge_access_rules`.
- `operational_facts`.
- `retrieval_queries`.
- `retrieval_feedback`.
- `conversation_sessions`.

Each document should include tenant, source, version, effective date, expiry date, owner, classification, and embedding status.

## 6. Chunking and indexing

Chunk documents by logical section, not arbitrary length alone. Preserve headings, policy identifiers, effective dates, and source links.

Metadata filters should include:

- Tenant.
- Region or branch.
- Role.
- Document type.
- Effective date.
- Product or operational domain.
- Confidentiality classification.

Use hybrid retrieval: structured filtering plus keyword and semantic search. Re-rank retrieved results before giving them to an AI assistant.

## 7. Memory retention

- Transactional records: retain according to business and legal requirements.
- Delivery proof: define retention period and deletion policy.
- Customer conversations: minimize and expire when no longer required.
- AI traces: retain enough for quality and audit, but redact sensitive values.
- Operational aggregates: retain long enough for seasonal analysis.

## 8. Retrieval safety

- Enforce authorization before retrieval, not after generation.
- Never allow a customer to retrieve another customer’s order.
- Redact phone numbers, addresses, payment data, and identity documents when unnecessary.
- Treat retrieved documents as untrusted content and defend against prompt injection.
- Display source and effective date for policy answers.

## 9. Claude Code implementation guidance

Create interfaces instead of coupling the application to one vector database:

```ts
export interface KnowledgeRetriever {
  search(input: {
    tenantId: string;
    userId: string;
    query: string;
    filters?: Record<string, string | string[]>;
    limit: number;
  }): Promise<RetrievedContext[]>;
}
```

The assistant should receive a context envelope:

```ts
export type ContextEnvelope = {
  structuredFacts: unknown[];
  policySources: unknown[];
  operationalPatterns: unknown[];
  limitations: string[];
  generatedAt: string;
};
```

## 10. Retrieval quality metrics

Track:

- Retrieval precision.
- Retrieval recall.
- Citation completeness.
- Permission violation rate.
- Stale-policy rate.
- Unsupported-answer rate.
- User correction rate.
- Time to retrieve context.