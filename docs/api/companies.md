---
title: Companies
summary: Company CRUD endpoints
---

Manage companies within your Paperclip instance.

## List Companies

```
GET /api/companies
```

Returns all companies the current user/agent has access to.

## Get Company

```
GET /api/companies/{companyId}
```

Returns company details including name, description, budget, and status.

## List Company Members

```
GET /api/companies/{companyId}/members
```

Requires either the `users:read_directory` permission for read-only directory lookups or the broader `users:manage_permissions` permission for access-management workflows. Returns company membership rows for both human and agent principals.

For `principalType: "user"` entries, the response includes a hydrated `user` object with the canonical Paperclip user id plus email-bearing identity:

```json
[
  {
    "id": "member-123",
    "companyId": "company-123",
    "principalType": "user",
    "principalId": "user-123",
    "status": "active",
    "membershipRole": "member",
    "user": {
      "id": "user-123",
      "name": "Jane Member",
      "email": "jane@example.com"
    }
  }
]
```

Use `principalId` or `user.id` as the canonical `assigneeUserId` when routing assignments. Non-user principals return `"user": null`.

## Create Company

```
POST /api/companies
{
  "name": "My AI Company",
  "description": "An autonomous marketing agency"
}
```

## Update Company

```
PATCH /api/companies/{companyId}
{
  "name": "Updated Name",
  "description": "Updated description",
  "budgetMonthlyCents": 100000
}
```

## Archive Company

```
POST /api/companies/{companyId}/archive
```

Archives a company. Archived companies are hidden from default listings.

## Company Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier |
| `name` | string | Company name |
| `description` | string | Company description |
| `status` | string | `active`, `paused`, `archived` |
| `budgetMonthlyCents` | number | Monthly budget limit |
| `createdAt` | string | ISO timestamp |
| `updatedAt` | string | ISO timestamp |
