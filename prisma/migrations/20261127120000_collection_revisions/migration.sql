-- #1231: correcting a copy or a rating change keeps its previous values as a
-- revision, which goes with the copy or rating change it belongs to.

-- CreateTable
CREATE TABLE "collection_copy_revisions" (
    "id" TEXT NOT NULL,
    "copy_id" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_copy_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_rating_revisions" (
    "id" TEXT NOT NULL,
    "rating_change_id" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_rating_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "collection_copy_revisions_copy_id_created_at_idx" ON "collection_copy_revisions"("copy_id", "created_at");

-- CreateIndex
CREATE INDEX "collection_rating_revisions_rating_change_id_created_at_idx" ON "collection_rating_revisions"("rating_change_id", "created_at");

-- AddForeignKey
ALTER TABLE "collection_copy_revisions" ADD CONSTRAINT "collection_copy_revisions_copy_id_fkey" FOREIGN KEY ("copy_id") REFERENCES "collection_copies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_rating_revisions" ADD CONSTRAINT "collection_rating_revisions_rating_change_id_fkey" FOREIGN KEY ("rating_change_id") REFERENCES "collection_rating_changes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
