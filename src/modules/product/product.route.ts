import express from 'express';
import { ProductController } from './product.controller';
import { protectRoute } from '../../middlewares/auth.middleware';
import multer from 'multer';

const router = express.Router();
const controller = new ProductController();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Apenas arquivos de imagem são permitidos') as any, false);
    }
  },
});

router.use(protectRoute as express.RequestHandler);

/**
 * @swagger
 * components:
 *   schemas:
 *     Product:
 *       type: object
 *       required:
 *         - name
 *         - category
 *         - variety
 *         - stock
 *         - description
 *         - images_Path
 *         - harvestAt
 *         - productRating
 *         - amountSold
 *         - isNegotiable
 *         - ratingAmount
 *         - ratingStarAmount
 *         - sellerId
 *         - sellingUnitProduct
 *       properties:
 *         name:
 *           type: string
 *           example: "Tomate"
 *         category:
 *           type: string
 *           example: "Hortaliça"
 *         variety:
 *           type: string
 *           example: "Cereja"
 *         stock:
 *           type: integer
 *           example: 100
 *         description:
 *           type: string
 *           example: "Tomate cereja orgânico, colhido fresco."
 *         images_Path:
 *           type: array
 *           description: "Caminhos dos arquivos no bucket S3 (ex.: uploads/<uuid>-arquivo.jpg)"
 *           items:
 *            type: string
 *            example: ["uploads/3a2b9f21-0b9a-4c12-b8a9-manga.jpg"]
 *         harvestAt:
 *           type: string
 *           format: date-time
 *           example: "2024-06-13T00:00:00.000Z"
 *         productRating:
 *           type: number
 *           example: 4.5
 *         amountSold:
 *           type: integer
 *           example: 20
 *         isNegotiable:
 *           type: boolean
 *           example: true
 *         ratingAmount:
 *           type: integer
 *           example: 10
 *         ratingStarAmount:
 *           type: array
 *           items:
 *             type: number
 *           example: [5, 4, 5, 3]
 *         sellerId:
 *           type: integer
 *           example: 1
 *         sellingUnitProduct:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               unitId:
 *                 type: integer
 *                 example: 1
 *               minPrice:
 *                 type: number
 *                 example: 5.99
 *         status:
 *           type: boolean
 *           example: true
 *
 * /products:
 *   post:
 *     summary: Cria um novo produto
 *     tags: [Product]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Product'
 *     responses:
 *       201:
 *         description: Produto criado com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Product'
 *       400:
 *         description: Erro de validação ou referência
 */
router.post('/', upload.array("images", 10), controller.create as express.RequestHandler);

/**
 * @swagger
 * /products:
 *   get:
 *     summary: Lista todos os produtos
 *     tags: [Product]
 *     parameters:
 *       - in: query
 *         name: name
 *         schema:
 *           type: string
 *         description: Nome do produto
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *         description: Categoria do produto
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, inactive, all]
 *           default: active
 *         description: >
 *           active = status true e colheita até hoje (Brasília); inactive = desativados ou com
 *           colheita encerrada; all = todos
 *     responses:
 *       200:
 *         description: Lista de produtos
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Product'
 */
router.get('/', controller.getAll as express.RequestHandler);

/**
 * @swagger
 * /products/selling-units:
 *   get:
 *     summary: Lista todas as unidades de venda
 *     tags: [Product]
 *     responses:
 *       200:
 *         description: Lista de unidades de venda
 */
router.get('/selling-units', controller.getSellingUnits as express.RequestHandler);

/**
 * @swagger
 * /products/best-sellers:
 *   get:
 *     summary: Produtos mais vendidos do market
 *     description: >
 *       Ordena por número de vendas efetivadas (entrada ou pagamento confirmado, exceto
 *       canceladas/recusadas). Exclui os produtos do próprio usuário e os de colheita vencida.
 *       Cada item traz o campo extra salesCount.
 *     tags: [Product]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *           minimum: 1
 *           maximum: 100
 *     responses:
 *       200:
 *         description: Lista de produtos ordenada por vendas
 */
router.get('/best-sellers', controller.getBestSellers as express.RequestHandler);

/**
 * @swagger
 * /products/{id}:
 *   get:
 *     summary: Busca produto por ID
 *     tags: [Product]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: ID do produto
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, inactive, all]
 *           default: active
 *         description: >
 *           active = status true e colheita até hoje (Brasília); inactive = desativados ou com
 *           colheita encerrada; all = todos
 *     responses:
 *       200:
 *         description: Produto encontrado
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Product'
 *       404:
 *         description: Produto não encontrado
 */
router.get('/:id', controller.getById as express.RequestHandler);

/**
 * @swagger
 * /products/user/{userId}:
 *   get:
 *     summary: Lista todos os produtos de um usuário
 *     tags: [Product]
 *     parameters:
 *       - in: path
 *         name: userId
 *         schema:
 *           type: integer
 *         required: true
 *         description: ID do usuário
 *       - in: query
 *         name: name
 *         schema:
 *           type: string
 *         required: false
 *         description: Nome parcial do produto (filtro opcional)
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *         required: false
 *         description: Categoria parcial do produto (filtro opcional)
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, inactive, all]
 *           default: active
 *         description: >
 *           active = status true e colheita até hoje (Brasília); inactive = desativados ou com
 *           colheita encerrada; all = todos
 *     responses:
 *       200:
 *         description: Lista de produtos do usuário
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Product'
 *       404:
 *         description: Nenhum produto encontrado
 */
router.get('/user/:userId', controller.getAllByUser as express.RequestHandler);

/**
 * @swagger
 * /products/{id}:
 *   put:
 *     summary: Atualiza um produto
 *     tags: [Product]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: ID do produto
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Product'
 *     responses:
 *       200:
 *         description: Produto atualizado
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Product'
 *       400:
 *         description: Erro ao atualizar produto
 */
router.put('/:id', upload.array("images", 10), controller.update as express.RequestHandler);

/**
 * @swagger
 * /products/{id}:
 *   delete:
 *     summary: Remove um produto
 *     tags: [Product]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: ID do produto
 *     responses:
 *       204:
 *         description: Produto removido
 *       404:
 *         description: Produto não encontrado
 */
router.delete('/:id', controller.delete as express.RequestHandler);

export default router;