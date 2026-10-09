-- Termo aditivo (diferença +/- do contrato após a pesagem). Registro automático em registerManualWeight.
-- Vendas pesadas antes desta migration ficam sem registro e aparecem como "sem termo aditivo" no dashboard.

-- CreateTable
CREATE TABLE "SaleAddendum" (
    "id" TEXT NOT NULL,
    "sale_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'weight_adjustment',
    "original_total" DECIMAL(12,2) NOT NULL,
    "adjusted_total" DECIMAL(12,2) NOT NULL,
    "difference" DECIMAL(12,2) NOT NULL,
    "weight_kg" DECIMAL(10,2),
    "weight_document_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaleAddendum_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SaleAddendum_sale_id_kind_key" ON "SaleAddendum"("sale_id", "kind");

-- AddForeignKey
ALTER TABLE "SaleAddendum" ADD CONSTRAINT "SaleAddendum_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "SaleData"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

