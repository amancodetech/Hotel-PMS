# Domain Boundary

No business domain is implemented in Phase 1. Future domain code must not import HTTP, ORM, Redis, or framework adapters. Application use cases own authorization and transaction orchestration; persistence owns database access. Tenant data access remains unavailable until Phase 3.
