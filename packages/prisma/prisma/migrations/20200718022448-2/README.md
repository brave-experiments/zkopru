# Migration `20200718022448-2`

This migration has been generated by Wanseob Lim at 7/18/2020, 2:24:48 AM.
You can check out the [state of the schema](./schema.prisma) after the migration.

## Database Steps

```sql
ALTER TABLE "public"."Block" DROP COLUMN "verified";

ALTER TABLE "public"."Proposal" DROP COLUMN "invalidated",
ADD COLUMN "isUncle" boolean   ,
ADD COLUMN "verified" boolean   ;
```

## Changes

```diff
diff --git schema.prisma schema.prisma
migration 20200712220410-initial..20200718022448-2
--- datamodel.dml
+++ datamodel.dml
@@ -1,12 +1,13 @@
 generator client {
   provider = "prisma-client-js"
-  output = "../generated/postgres"
+  binaryTargets = ["darwin", "windows", "native", "linux-musl", "debian-openssl-1.0.x", "debian-openssl-1.1.x"]
+  output = "../generated/postgres-migrator"
 }
 datasource postgres {
   provider = "postgres"
-  url = "***"
+  url = "***"
 }
 model EncryptedWallet {
   id String @id @default(uuid())
@@ -54,15 +55,15 @@
   proposalTx String? // tx hash
   proposalData String? // stringified json
   fetched String?
   finalized Boolean?
-  invalidated Boolean?
+  verified Boolean?
+  isUncle Boolean?
   block Block? @relation(fields: [fetched], references: [hash])
 }
 model Block {
   hash String @id
-  verified Boolean?
   header Header @relation(fields: [hash], references: [hash])
   proposal Proposal
   bootstrap Bootstrap?
 }
```


