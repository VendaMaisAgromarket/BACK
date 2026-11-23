import { Router, Request, Response, NextFunction, RequestHandler } from "express";
import { protectRoute, requireAdmin } from "../../middlewares/auth.middleware";
import { uploadCertificationDocumentsMiddleware as uploadDocuments } from "./certificationUpload.middleware";
import { HarvestCertificationController } from "./harvestCertification.controller";

const router = Router();
const controller = new HarvestCertificationController();

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown> | void) =>
    (req: Request, res: Response, next: NextFunction) =>
      Promise.resolve(fn(req, res)).catch(next);

/**
 * @swagger
 * tags:
 *   - name: HarvestCertification
 *     description: Certificação de safra/produto (selo de safra certificada nos anúncios vinculados)
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     HarvestCertificationDetail:
 *       type: object
 *       description: Detalhe da certificação de safra (GET /:id e retorno de POST, PUT, approve, reject e revoke)
 *       properties:
 *         id: { type: string, format: uuid }
 *         userId: { type: string, format: uuid }
 *         harvestSeason: { type: string, example: "2026/27", description: "Ano agrícola" }
 *         crop: { type: string, example: Tomate }
 *         variety: { type: string, nullable: true, example: Italiano }
 *         plotIdentifier: { type: string, example: "Talhão 3", description: "Talhão/lote" }
 *         plantedAreaHectares: { type: string, description: "Decimal serializado como string", example: "4.5" }
 *         estimatedProduction: { type: string, description: "Decimal serializado como string", example: "120" }
 *         productionUnit: { type: string, enum: [KG, TON] }
 *         plantingDate: { type: string, format: date-time, description: "Início do dia em Brasília" }
 *         harvestDate: { type: string, format: date-time, description: "Início do dia em Brasília" }
 *         type: { type: string, enum: [TRACEABILITY, RESIDUE_ANALYSIS, ORGANIC, GLOBALGAP, OTHER] }
 *         certifierName: { type: string }
 *         certifierCnpj: { type: string, example: "11.222.333/0001-81" }
 *         certificateNumber: { type: string }
 *         issuedAt: { type: string, format: date-time }
 *         validUntil: { type: string, format: date-time }
 *         origin: { type: string, enum: [UPLOADED, PURCHASED] }
 *         status: { type: string, enum: [PENDING, APPROVED, REJECTED, EXPIRED, REVOKED] }
 *         revision:
 *           type: integer
 *           minimum: 0
 *           description: "Versão dos dados: +1 a cada reenvio. Enviar em approve/reject (obrigatório) e revoke (opcional); valor desatualizado → 409"
 *         reviewedById: { type: string, nullable: true }
 *         reviewedAt: { type: string, format: date-time, nullable: true }
 *         rejectionReason: { type: string, nullable: true }
 *         reviewNotes: { type: string, nullable: true }
 *         createdAt: { type: string, format: date-time }
 *         updatedAt: { type: string, format: date-time }
 *         badgeActive: { type: boolean, description: "Selo no ar hoje (APPROVED e dentro da validade)" }
 *         reviewedBy: { type: object, nullable: true, properties: { id: { type: string }, name: { type: string } } }
 *         products:
 *           type: array
 *           description: Anúncios vinculados
 *           items:
 *             type: object
 *             properties:
 *               id: { type: string }
 *               name: { type: string }
 *               variety: { type: string }
 *               harvestAt: { type: string, format: date-time }
 *               status: { type: boolean }
 *         documents:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               id: { type: string }
 *               docType: { type: string, enum: [CERTIFICATE, AUDIT_REPORT, OTHER] }
 *               originalName: { type: string }
 *               mimeType: { type: string }
 *               sizeBytes: { type: integer }
 *               uploadedAt: { type: string, format: date-time }
 *               uploadedBy: { type: object, properties: { id: { type: string }, name: { type: string } } }
 *         events:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               id: { type: string }
 *               action: { type: string, enum: [SUBMITTED, RESUBMITTED, APPROVED, REJECTED, REVOKED, EXPIRED] }
 *               fromStatus: { type: string, nullable: true }
 *               toStatus: { type: string }
 *               note: { type: string, nullable: true }
 *               createdAt: { type: string, format: date-time }
 *               actor: { type: object, nullable: true, properties: { id: { type: string }, name: { type: string }, role: { type: string } } }
 *               document: { type: object, nullable: true, properties: { id: { type: string }, docType: { type: string }, originalName: { type: string } } }
 *         user:
 *           type: object
 *           description: "Só para admin"
 *           properties:
 *             id: { type: string }
 *             name: { type: string }
 *             email: { type: string }
 *             phone_number: { type: string }
 *             cpf: { type: string, nullable: true }
 *             cnpj: { type: string, nullable: true }
 *             ccir: { type: string, nullable: true }
 *     HarvestCertificationBadge:
 *       type: object
 *       nullable: true
 *       description: Selo de safra de um anúncio (só certificação ativa; dados não sensíveis)
 *       properties:
 *         id: { type: string }
 *         type: { type: string, enum: [TRACEABILITY, RESIDUE_ANALYSIS, ORGANIC, GLOBALGAP, OTHER] }
 *         certifierName: { type: string }
 *         certificateNumber: { type: string }
 *         harvestSeason: { type: string }
 *         crop: { type: string }
 *         variety: { type: string, nullable: true }
 *         validUntil: { type: string, format: date-time }
 */

/**
 * @swagger
 * /certifications/harvest/product/{productId}/badge:
 *   get:
 *     summary: Selo público de safra de um anúncio (sem token; só dados não sensíveis)
 *     tags: [HarvestCertification]
 *     security: []
 *     parameters:
 *       - { in: path, name: productId, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: "{ productId, certified, certification }"
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 productId: { type: string }
 *                 certified: { type: boolean }
 *                 certification: { $ref: '#/components/schemas/HarvestCertificationBadge' }
 *       404: { description: Anúncio não encontrado }
 */
router.get("/product/:productId/badge", wrap(controller.getProductBadge.bind(controller)));

router.use(protectRoute as RequestHandler);

// ─── Admin ─────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /certifications/harvest/admin:
 *   get:
 *     summary: Fila de certificações de safra para avaliação (admin)
 *     tags: [HarvestCertification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [PENDING, APPROVED, REJECTED, EXPIRED, REVOKED], default: PENDING }
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [TRACEABILITY, RESIDUE_ANALYSIS, ORGANIC, GLOBALGAP, OTHER] }
 *       - { in: query, name: userId, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 50, default: 20 } }
 *       - { in: query, name: cursor, schema: { type: string } }
 *     responses:
 *       200: { description: "{ items, nextCursor } — cada item traz user, reviewedBy e _count { documents, products }" }
 *       403: { description: Apenas admin }
 */
router.get("/admin", requireAdmin, wrap(controller.listForAdmin.bind(controller)));

/**
 * @swagger
 * /certifications/harvest/admin/{id}/approve:
 *   patch:
 *     summary: Aprova uma certificação de safra pendente (selo nos anúncios vinculados)
 *     tags: [HarvestCertification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [revision]
 *             properties:
 *               revision: { type: integer, description: "Campo `revision` do detalhe que o admin analisou" }
 *               documentId: { type: string, description: "Documento que embasou a aprovação (padrão: certificado mais recente)" }
 *               notes: { type: string }
 *     responses:
 *       200:
 *         description: Certificação aprovada, com histórico
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/HarvestCertificationDetail' }
 *       400: { description: "Sem revision, ou documento de outra certificação" }
 *       409: { description: "Não está pendente, já venceu, ou revision desatualizada" }
 */
router.patch("/admin/:id/approve", requireAdmin, wrap(controller.approve.bind(controller)));

/**
 * @swagger
 * /certifications/harvest/admin/{id}/reject:
 *   patch:
 *     summary: Recusa uma certificação de safra pendente (o dono pode corrigir e reenviar)
 *     tags: [HarvestCertification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [revision, reason]
 *             properties:
 *               revision: { type: integer, description: "Campo `revision` do detalhe que o admin analisou" }
 *               reason: { type: string }
 *               notes: { type: string }
 *     responses:
 *       200:
 *         description: Certificação recusada, com histórico
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/HarvestCertificationDetail' }
 *       409: { description: "Não está pendente, ou revision desatualizada" }
 */
router.patch("/admin/:id/reject", requireAdmin, wrap(controller.reject.bind(controller)));

/**
 * @swagger
 * /certifications/harvest/admin/{id}/revoke:
 *   patch:
 *     summary: Revoga uma certificação de safra aprovada (o selo sai dos anúncios)
 *     tags: [HarvestCertification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               revision: { type: integer, description: "Opcional: se enviado, precisa ser o atual" }
 *               reason: { type: string }
 *               notes: { type: string }
 *     responses:
 *       200:
 *         description: Certificação revogada, com histórico
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/HarvestCertificationDetail' }
 *       409: { description: "Não está aprovada, ou revision enviada e desatualizada" }
 */
router.patch("/admin/:id/revoke", requireAdmin, wrap(controller.revoke.bind(controller)));

// ─── Dono da certificação (qualquer usuário autenticado que não seja admin) ────

/**
 * @swagger
 * /certifications/harvest:
 *   post:
 *     summary: Usuário (produtor ou comprador que anuncia; não admin) envia a certificação de uma safra
 *     tags: [HarvestCertification]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [harvestSeason, crop, plotIdentifier, plantedAreaHectares, estimatedProduction, productionUnit, plantingDate, harvestDate, type, certifierName, certifierCnpj, certificateNumber, issuedAt, validUntil, documents]
 *             properties:
 *               harvestSeason: { type: string, example: "2026/27", description: "Ano agrícola (AAAA/AA consecutivos) ou um ano (AAAA)" }
 *               crop: { type: string, example: Tomate }
 *               variety: { type: string, example: Italiano }
 *               plotIdentifier: { type: string, example: "Talhão 3" }
 *               plantedAreaHectares: { type: number, example: 4.5 }
 *               estimatedProduction: { type: number, example: 120 }
 *               productionUnit: { type: string, enum: [KG, TON] }
 *               plantingDate: { type: string, format: date, example: "2026-08-01" }
 *               harvestDate: { type: string, format: date, example: "2026-12-10", description: "Não antes do plantio; dentro do ano agrícola" }
 *               type: { type: string, enum: [TRACEABILITY, RESIDUE_ANALYSIS, ORGANIC, GLOBALGAP, OTHER] }
 *               certifierName: { type: string }
 *               certifierCnpj: { type: string }
 *               certificateNumber: { type: string }
 *               issuedAt: { type: string, format: date, example: "2026-10-01" }
 *               validUntil: { type: string, format: date, example: "2027-03-31" }
 *               documents:
 *                 type: array
 *                 items: { type: string, format: binary }
 *                 description: "1 a 5 arquivos (PDF/JPG/PNG/WEBP, até 10 MB cada)"
 *               documentTypes:
 *                 type: array
 *                 items: { type: string, enum: [CERTIFICATE, AUDIT_REPORT, OTHER] }
 *                 description: "Tipo de cada arquivo, na mesma ordem (padrão: CERTIFICATE)"
 *     responses:
 *       201:
 *         description: Certificação criada como PENDING (revision 0)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/HarvestCertificationDetail' }
 *       400: { description: Dados ou arquivos inválidos }
 *       403: { description: Administradores não podem enviar certificações }
 *       409: { description: Certificado já pendente ou aprovado }
 */
router.post("/", uploadDocuments, wrap(controller.create.bind(controller)));

/**
 * @swagger
 * /certifications/harvest/mine:
 *   get:
 *     summary: Certificações de safra do usuário logado (com `badgeActive`, documentos e anúncios vinculados)
 *     tags: [HarvestCertification]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Lista de certificações }
 */
router.get("/mine", wrap(controller.listMine.bind(controller)));

/**
 * @swagger
 * /certifications/harvest/{id}:
 *   get:
 *     summary: Detalhe com documentos, histórico e anúncios vinculados (dono ou admin)
 *     tags: [HarvestCertification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Certificação; para admin inclui `user` com os dados do dono
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/HarvestCertificationDetail' }
 *       404: { description: Não encontrada }
 *   put:
 *     summary: Corrige e reenvia uma certificação pendente ou recusada (volta a PENDING; anúncios seguem vinculados)
 *     tags: [HarvestCertification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             description: "Mesmos campos do POST; `documents` é opcional (novos arquivos são anexados aos existentes)"
 *     responses:
 *       200:
 *         description: Certificação reenviada (revision incrementada)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/HarvestCertificationDetail' }
 *       409: { description: Status não permite edição, ou alteração concorrente }
 */
router.get("/:id", wrap(controller.getById.bind(controller)));
router.put("/:id", uploadDocuments, wrap(controller.resubmit.bind(controller)));

/**
 * @swagger
 * /certifications/harvest/{id}/documents/{documentId}/url:
 *   get:
 *     summary: URL temporária (10 min) para visualizar/baixar um documento (dono ou admin)
 *     tags: [HarvestCertification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: path, name: documentId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ url, expiresIn, originalName, mimeType }" }
 *       404: { description: Não encontrado }
 */
router.get("/:id/documents/:documentId/url", wrap(controller.getDocumentUrl.bind(controller)));

/**
 * @swagger
 * /certifications/harvest/{id}/products/{productId}:
 *   put:
 *     summary: Vincula a certificação a um anúncio do mesmo dono (substitui a certificação anterior do anúncio)
 *     description: >
 *       A certificação precisa estar PENDING ou APPROVED e válida hoje; a cultura precisa aparecer no
 *       nome/variedade/categoria do anúncio; a colheita do anúncio precisa cair entre o plantio e a validade.
 *       O selo só aparece no anúncio quando a certificação estiver aprovada e válida.
 *     tags: [HarvestCertification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: path, name: productId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "Anúncio vinculado: { id, name, variety, harvestAt, status, harvestCertificationId }" }
 *       400: { description: Cultura não confere, ou colheita do anúncio fora do período da certificação }
 *       404: { description: Certificação ou anúncio não encontrado (ou de outro usuário) }
 *       409: { description: Certificação recusada, revogada ou vencida }
 *   delete:
 *     summary: Desvincula a certificação de um anúncio do dono
 *     tags: [HarvestCertification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: path, name: productId, required: true, schema: { type: string } }
 *     responses:
 *       204: { description: Desvinculado }
 *       404: { description: Anúncio não vinculado a esta certificação }
 */
router.put("/:id/products/:productId", wrap(controller.linkProduct.bind(controller)));
router.delete("/:id/products/:productId", wrap(controller.unlinkProduct.bind(controller)));

export default router;
