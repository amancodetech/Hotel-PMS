import { Migration } from '@mikro-orm/migrations';

export class Migration20260913200000_invitation_authority extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "invitation"
        add column "invited_by_membership_id" uuid,
        add column "role_version" integer,
        add column "approval_id" uuid,
        add constraint "invitation_inviter_fk"
          foreign key ("invited_by_membership_id", "tenant_id")
          references "membership" ("id", "tenant_id") on delete set null,
        add constraint "invitation_approval_fk"
          foreign key ("approval_id", "tenant_id")
          references "approval_request" ("id", "tenant_id") on delete set null
    `);
    this.addSql(`
      create index "invitation_pending_authority_idx"
        on "invitation" ("tenant_id", "status", "invited_by_membership_id")
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "invitation_pending_authority_idx"`);
    this.addSql(`
      alter table "invitation"
        drop constraint if exists "invitation_approval_fk",
        drop constraint if exists "invitation_inviter_fk",
        drop column if exists "approval_id",
        drop column if exists "role_version",
        drop column if exists "invited_by_membership_id"
    `);
  }
}
