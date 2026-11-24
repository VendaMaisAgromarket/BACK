import { Router, Request, Response, NextFunction, RequestHandler } from "express";
import { protectRoute, requireAdmin } from "../../middlewares/auth.middleware";
import { FarmCertificationController } from "./farmCertification.controller";
import { uploadCertificationDocumentsMiddleware } from "./certificationUpload.middleware";

const router = Router();
const controller = new FarmCertificationController();

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown> | void) =>
    (req: Request, res: Response, next: NextFunction) =>
      Promise.resolve(fn(req, res)).catch(next);

const uploadDocuments = uploadCertificationDocumentsMiddleware;

/**
 * @swagger
 * tags:
 *   - name: FarmCertification
 *     description: Certificação de fazenda (selo de fazenda certificada do vendedor)
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     CertificationHistoryEvent:
 *       type: object
 *       description: Evento do histórico de uma certificação (fazenda ou safra). Quem fez e os dados são retratos do momento da ação.
 *       properties:
 *         id: { type: string }
 *         action: { type: string, enum: [SUBMITTED, RESUBMITTED, DOCUMENT_ADDED, APPROVED, REJECTED, REVOKED, EXPIRED, PAYMENT_CONFIRMED] }
 *         fromStatus: { type: string, nullable: true }
 *         toStatus: { type: string }
 *         performedBy: { type: string, nullable: true, enum: [producer, buyer, admin, system], description: "Papel de quem fez, no momento" }
 *         actor:
 *           type: object
 *           nullable: true
 *           description: "Quem fez (null = sistema). Em APPROVED, é quem deu o aval."
 *           properties: { id: { type: string }, name: { type: string }, role: { type: string } }
 *         revision: { type: integer, nullable: true, description: "Revisão dos dados a que a ação se refere (null em eventos antigos)" }
 *         document:
 *           type: object
 *           nullable: true
 *           description: Arquivo referenciado (em APPROVED, o documento que embasou o aval)
 *           properties: { id: { type: string }, docType: { type: string }, originalName: { type: string } }
 *         note: { type: string, nullable: true, description: "Motivo/observação" }
 *         details:
 *           type: object
 *           nullable: true
 *           description: "Envio/avaliação: { certifierName, certifierCnpj, certificateNumber, issuedAt, validUntil } (quem certificou). DOCUMENT_ADDED: { originalName, docType, mimeType, sizeBytes }."
 *         createdAt: { type: string, format: date-time }
 *     CertificationApproval:
 *       type: object
 *       nullable: true
 *       description: Aprovação mais recente (null se nunca aprovada)
 *       properties:
 *         approvedAt: { type: string, format: date-time }
 *         approvedBy: { type: object, nullable: true, description: "Quem deu o aval (admin)", properties: { id: { type: string }, name: { type: string } } }
 *         revision: { type: integer, nullable: true }
 *         document: { type: object, nullable: true, properties: { id: { type: string }, docType: { type: string }, originalName: { type: string } } }
 *         note: { type: string, nullable: true }
 *         certifiedBy:
 *           type: object
 *           description: Quem certificou (certificadora e certificado aprovados)
 *           properties:
 *             certifierName: { type: string }
 *             certifierCnpj: { type: string }
 *             certificateNumber: { type: string }
 *             validUntil: { type: string, format: date-time }
 *     FarmCertificationDetail:
 *       type: object
 *       description: Detalhe da certificação (GET /:id e retorno de POST, PUT, approve, reject e revoke)
 *       properties:
 *         id: { type: string, format: uuid }
 *         userId: { type: string, format: uuid }
 *         farmName: { type: string }
 *         city: { type: string }
 *         uf: { type: string, example: MG }
 *         ccir: { type: string, nullable: true }
 *         car: { type: string, nullable: true }
 *         areaHectares: { type: string, description: "Decimal serializado como string", example: "12.5" }
 *         type: { type: string, enum: [ORGANIC_SISORG, GLOBALGAP, RAINFOREST_ALLIANCE, FAIR_TRADE, OTHER] }
 *         certifierName: { type: string }
 *         certifierCnpj: { type: string, example: "11.222.333/0001-81" }
 *         certificateNumber: { type: string }
 *         issuedAt: { type: string, format: date-time, description: "Início do dia em Brasília" }
 *         validUntil: { type: string, format: date-time, description: "Início do dia em Brasília" }
 *         origin: { type: string, enum: [UPLOADED, PURCHASED] }
 *         status: { type: string, enum: [PENDING, APPROVED, REJECTED, EXPIRED, REVOKED] }
 *         revision:
 *           type: integer
 *           minimum: 0
 *           description: "Versão dos dados: +1 a cada reenvio do dono. Enviar em approve/reject (obrigatório) e revoke (opcional); valor desatualizado → 409"
 *         reviewedById: { type: string, nullable: true }
 *         reviewedAt: { type: string, format: date-time, nullable: true }
 *         rejectionReason: { type: string, nullable: true }
 *         reviewNotes: { type: string, nullable: true }
 *         createdAt: { type: string, format: date-time }
 *         updatedAt: { type: string, format: date-time }
 *         badgeActive: { type: boolean, description: "Selo no ar hoje (APPROVED e dentro da validade)" }
 *         reviewedBy:
 *           type: object
 *           nullable: true
 *           properties: { id: { type: string }, name: { type: string } }
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
 *           description: Histórico em ordem cronológica
 *           items: { $ref: '#/components/schemas/CertificationHistoryEvent' }
 *         approval: { $ref: '#/components/schemas/CertificationApproval' }
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
 */

/**
 * @swagger
 * /certifications/farm/badge/{userId}:
 *   get:
 *     summary: Selo público de fazenda certificada de um usuário vendedor (só dados não sensíveis)
 *     tags: [FarmCertification]
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: "{ userId, certified, certifications: [{ id, type, certifierName, certificateNumber, city, uf, validUntil }] }"
 */
router.get("/badge/:userId", wrap(controller.getBadge.bind(controller)));

router.use(protectRoute as RequestHandler);

// ─── Admin ─────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /certifications/farm/admin:
 *   get:
 *     summary: Fila de certificações de fazenda para avaliação (admin)
 *     tags: [FarmCertification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [PENDING, APPROVED, REJECTED, EXPIRED, REVOKED], default: PENDING }
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [ORGANIC_SISORG, GLOBALGAP, RAINFOREST_ALLIANCE, FAIR_TRADE, OTHER] }
 *       - in: query
 *         name: userId
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 50, default: 20 }
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *     responses:
 *       200: { description: "{ items, nextCursor }" }
 *       403: { description: Apenas admin }
 */
router.get("/admin", requireAdmin, wrap(controller.listForAdmin.bind(controller)));

/**
 * @swagger
 * /certifications/farm/admin/history:
 *   get:
 *     summary: Histórico de todas as certificações de fazenda (admin) — quem fez, quando, qual documento, quem certificou e quem deu o aval
 *     tags: [FarmCertification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: action
 *         schema: { type: string, enum: [SUBMITTED, RESUBMITTED, DOCUMENT_ADDED, APPROVED, REJECTED, REVOKED, EXPIRED, PAYMENT_CONFIRMED] }
 *       - { in: query, name: certificationId, schema: { type: string } }
 *       - { in: query, name: actorId, schema: { type: string }, description: "Quem fez (ex.: um admin, para ver tudo o que ele aprovou)" }
 *       - { in: query, name: from, schema: { type: string, format: date }, description: "Dia inicial (Brasília), inclusive" }
 *       - { in: query, name: to, schema: { type: string, format: date }, description: "Dia final (Brasília), inclusive" }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 50 } }
 *       - { in: query, name: cursor, schema: { type: string } }
 *     responses:
 *       200:
 *         description: "{ items, nextCursor } — cada item é um evento (ver CertificationHistoryEvent) com `certification` (resumo: dono, certificadora, número)"
 *       400: { description: Filtro inválido }
 *       403: { description: Apenas admin }
 */
router.get("/admin/history", requireAdmin, wrap(controller.listHistory.bind(controller)));

/**
 * @swagger
 * /certifications/farm/admin/{id}/approve:
 *   patch:
 *     summary: Aprova uma certificação pendente (ativa o selo)
 *     tags: [FarmCertification]
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
 *             schema: { $ref: '#/components/schemas/FarmCertificationDetail' }
 *       409: { description: "Não está pendente, o certificado já venceu, ou o dono reenviou depois (revision desatualizada)" }
 */
router.patch("/admin/:id/approve", requireAdmin, wrap(controller.approve.bind(controller)));

/**
 * @swagger
 * /certifications/farm/admin/{id}/reject:
 *   patch:
 *     summary: Recusa uma certificação pendente (o dono pode corrigir e reenviar)
 *     tags: [FarmCertification]
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
 *             schema: { $ref: '#/components/schemas/FarmCertificationDetail' }
 *       409: { description: "Não está pendente, ou revision desatualizada" }
 */
router.patch("/admin/:id/reject", requireAdmin, wrap(controller.reject.bind(controller)));

/**
 * @swagger
 * /certifications/farm/admin/{id}/revoke:
 *   patch:
 *     summary: Revoga uma certificação aprovada (remove o selo)
 *     tags: [FarmCertification]
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
 *             schema: { $ref: '#/components/schemas/FarmCertificationDetail' }
 *       409: { description: "Não está aprovada, ou revision enviada e desatualizada" }
 */
router.patch("/admin/:id/revoke", requireAdmin, wrap(controller.revoke.bind(controller)));

// ─── Dono da certificação (qualquer usuário autenticado que não seja admin) ────

/**
 * @swagger
 * /certifications/farm:
 *   post:
 *     summary: Usuário (produtor ou comprador que anuncia; não admin) envia a certificação da fazenda para avaliação
 *     tags: [FarmCertification]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [farmName, city, uf, areaHectares, type, certifierName, certifierCnpj, certificateNumber, issuedAt, validUntil, documents]
 *             properties:
 *               farmName: { type: string }
 *               city: { type: string }
 *               uf: { type: string, example: MG }
 *               ccir: { type: string, description: "CCIR e/ou CAR (ao menos um)" }
 *               car: { type: string }
 *               areaHectares: { type: number, example: 12.5 }
 *               type: { type: string, enum: [ORGANIC_SISORG, GLOBALGAP, RAINFOREST_ALLIANCE, FAIR_TRADE, OTHER] }
 *               certifierName: { type: string }
 *               certifierCnpj: { type: string }
 *               certificateNumber: { type: string }
 *               issuedAt: { type: string, format: date, example: "2026-03-01" }
 *               validUntil: { type: string, format: date, example: "2027-03-01" }
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
 *             schema: { $ref: '#/components/schemas/FarmCertificationDetail' }
 *       400: { description: Dados ou arquivos inválidos }
 *       403: { description: Administradores não podem enviar certificações }
 *       409: { description: Certificado já pendente ou aprovado }
 */
router.post("/", uploadDocuments, wrap(controller.create.bind(controller)));

/**
 * @swagger
 * /certifications/farm/mine:
 *   get:
 *     summary: Certificações de fazenda do usuário logado (com `badgeActive`)
 *     tags: [FarmCertification]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Lista de certificações com documentos }
 */
router.get("/mine", wrap(controller.listMine.bind(controller)));

/**
 * @swagger
 * /certifications/farm/{id}:
 *   get:
 *     summary: Detalhe com documentos e histórico (dono ou admin)
 *     tags: [FarmCertification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Certificação; para admin inclui `user` com os dados do dono
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/FarmCertificationDetail' }
 *       404: { description: Não encontrada }
 *   put:
 *     summary: Corrige e reenvia uma certificação pendente ou recusada (volta a PENDING)
 *     tags: [FarmCertification]
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
 *             schema: { $ref: '#/components/schemas/FarmCertificationDetail' }
 *       409: { description: Status não permite edição }
 */
router.get("/:id", wrap(controller.getById.bind(controller)));
router.put("/:id", uploadDocuments, wrap(controller.resubmit.bind(controller)));

/**
 * @swagger
 * /certifications/farm/{id}/documents/{documentId}/url:
 *   get:
 *     summary: URL temporária (10 min) para visualizar/baixar um documento (dono ou admin)
 *     tags: [FarmCertification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *       - { in: path, name: documentId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ url, expiresIn, originalName, mimeType }" }
 *       404: { description: Não encontrado }
 */
router.get("/:id/documents/:documentId/url", wrap(controller.getDocumentUrl.bind(controller)));

export default router;
