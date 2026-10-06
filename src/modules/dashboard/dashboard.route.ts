import express, { RequestHandler } from "express";
import { DashboardController } from "./dashboard.controller";
import { protectRoute, requireAdmin } from "../../middlewares/auth.middleware";

const router = express.Router();
const controller = new DashboardController();

router.use(protectRoute as RequestHandler);
router.use(requireAdmin as RequestHandler);

/**
 * @swagger
 * /dashboard/executive-overview:
 *   get:
 *     summary: Visão Executiva do dashboard (Faturamento, Receita e Operações — Previsto x Realizado, últimos 12 meses)
 *     description: >
 *       Faturamento: valor total contratado por venda (produtos + frete, ou adjustedContractTotal quando houver).
 *       Receita: valor efetivamente recebido (soma de Payment com status='completed').
 *       Operações: contagem de vendas.
 *       Previsto agrupa pelo mês de plannedDeliveryDate; Realizado agrupa pelo mês de actualDeliveryDate
 *       (Faturamento/Operações) ou pelo mês de confirmação do pagamento (Receita).
 *       counters/pipeline/faturamentoPorProduto/origemDestino/principaisCompradores/principaisVendedores
 *       consideram vendas com createdAt nos últimos 12 meses (mesmo critério de "período" do
 *       GET /dashboard/pipeline), já com os filtros produto/comprador/vendedor aplicados.
 *       Ativa/Concluída/Bloqueada reaproveitam a mesma etapa do pipeline (calculatePipelineStage):
 *       stage 10 = concluída, stage 0 (Cancelado/Recusado) = bloqueada, 1-9 = ativa. valorRetido soma
 *       pagamentos completed das vendas entre as etapas "Pagamento em escrow" (2) e "Aceite" (8) —
 *       pago pelo comprador, ainda não liberado ao vendedor.
 *     tags: [Dashboard]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: produto
 *         schema: { type: string, format: uuid }
 *         description: Filtra por id do produto (ver filterOptions.produtos)
 *       - in: query
 *         name: comprador
 *         schema: { type: string, format: uuid }
 *         description: Filtra por id do comprador (ver filterOptions.compradores)
 *       - in: query
 *         name: vendedor
 *         schema: { type: string, format: uuid }
 *         description: Filtra por id do vendedor (ver filterOptions.vendedores)
 *       - in: query
 *         name: tipoOperacao
 *         schema: { type: string }
 *         description: >
 *           Aceito por paridade com os demais filtros, mas sem efeito hoje — não há campo no schema
 *           que represente "tipo de operação" (em standby até o cliente definir a fonte do dado).
 *           filterOptions.tiposOperacao sempre retorna [].
 *     responses:
 *       200:
 *         description: Dados agregados dos últimos 12 meses
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 period:
 *                   type: object
 *                   properties:
 *                     from: { type: string, example: "2025-08" }
 *                     to: { type: string, example: "2026-07" }
 *                 faturamento:
 *                   type: object
 *                   properties:
 *                     monthly:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           month: { type: string, example: "2026-07" }
 *                           label: { type: string, example: "jul/2026" }
 *                           previsto: { type: number, example: 125000.00 }
 *                           realizado: { type: number, example: 98000.00 }
 *                     accumulated:
 *                       type: object
 *                       properties:
 *                         previsto: { type: number }
 *                         realizado: { type: number }
 *                 receita:
 *                   type: object
 *                   description: Mesma estrutura de faturamento
 *                 operacoes:
 *                   type: object
 *                   properties:
 *                     monthly:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           month: { type: string, example: "2026-07" }
 *                           label: { type: string, example: "jul/2026" }
 *                           previsto: { type: integer, example: 12 }
 *                           realizado: { type: integer, example: 10 }
 *                 counters:
 *                   type: object
 *                   properties:
 *                     operacoesAtivas: { type: integer, example: 45 }
 *                     operacoesConcluidas: { type: integer, example: 32 }
 *                     operacoesBloqueadas: { type: integer, example: 8 }
 *                     valorRetido: { type: number, example: 350000.0, description: "Pagamentos completed em escrow (etapas 2-8), ainda não liberados ao vendedor" }
 *                 filterOptions:
 *                   type: object
 *                   properties:
 *                     produtos:
 *                       type: array
 *                       items: { type: object, properties: { id: { type: string, format: uuid }, name: { type: string } } }
 *                     compradores:
 *                       type: array
 *                       items: { type: object, properties: { id: { type: string, format: uuid }, name: { type: string } } }
 *                     vendedores:
 *                       type: array
 *                       items: { type: object, properties: { id: { type: string, format: uuid }, name: { type: string } } }
 *                     tiposOperacao:
 *                       type: array
 *                       items: { type: object }
 *                       description: Sempre [] — ver descrição do parâmetro tipoOperacao
 *                 faturamentoPorProduto:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       produto: { type: string, example: "Manga" }
 *                       valor: { type: number, example: 1470000.0 }
 *                       percentual: { type: number, example: 60.0 }
 *                 origemDestino:
 *                   type: array
 *                   description: Uma linha por rota (UF origem do vendedor → UF destino da entrega)
 *                   items:
 *                     type: object
 *                     properties:
 *                       origem: { type: string, example: "SP" }
 *                       destino: { type: string, example: "RJ" }
 *                       quantidade: { type: integer, example: 8 }
 *                       valor: { type: number, example: 245000.0 }
 *                 principaisCompradores:
 *                   type: array
 *                   description: Top 5 por faturamento + bucket "Outros" com o restante
 *                   items:
 *                     type: object
 *                     properties:
 *                       nome: { type: string, example: "Exportadora XPTO" }
 *                       faturamento: { type: number, example: 780000.0 }
 *                       percentualParticipacao: { type: number, example: 21.4 }
 *                 principaisVendedores:
 *                   type: array
 *                   description: Mesma estrutura de principaisCompradores
 *                 pipeline:
 *                   type: object
 *                   description: Mesmo formato de statusCounts/terminal/funnel de GET /dashboard/pipeline, calculado sobre o período/filtros deste endpoint
 *       401: { description: Não autenticado }
 *       403: { description: Acesso restrito a administradores }
 */
router.get("/executive-overview", controller.getExecutiveOverview as RequestHandler);

/**
 * @swagger
 * /dashboard/pipeline:
 *   get:
 *     summary: Pipeline das Operações — contadores, funil, gargalos, filtros e lista detalhada
 *     description: >
 *       statusCounts: contagem de vendas em cada uma das 10 etapas internas do pipeline (ver src/lib/pipelineStage.ts).
 *       terminal: contagem de vendas em estados terminais fora do fluxo (Cancelado, Recusado pelo vendedor).
 *       funnel: 8 baldes cumulativos (Contrato Criado → Finalizada, ver PIPELINE_STATUS_FILTER_OPTIONS) — cada balde
 *       conta vendas que já alcançaram ao menos aquela etapa; vendas Canceladas/Recusadas ficam fora do funil.
 *       counters: operacoesAtivas (etapas 1-9), finalizadas (etapa 10), aguardandoPagamento (etapa 1),
 *       bloqueadas (Payment pending vencido há mais de 3 dias — mesma regra de /dashboard/alerts.pagamentoVencido,
 *       é um SELO sobre a etapa real, não uma etapa nova), taxaConversaoPercent e totalContratos (ativas+finalizadas).
 *       gargalos: aguardandoPagamento/bloqueadas (= counters) + semDocumentos/entregaAtrasada (mesmas regras de
 *       /dashboard/alerts, restritas ao período/filtros desta chamada).
 *       filterOptions: produtos/compradores/vendedores/tiposOperacao (tiposOperacao sempre [], ver descrição do
 *       parâmetro tipoOperacao) + status (opções prontas do dropdown "Status" — cada uma já diz se filtra por
 *       stage ou por blocked, pra não precisar hardcodar números de etapa no front).
 *       list: 1 linha por venda (produto/vendedor resumidos quando há múltiplos itens), status já consolidado/exibível
 *       ("Aguardando Pagamento", "Liberado para Embarque" etc., ou "Bloqueada" quando aplicável) e dias na etapa atual.
 *       Paginada — statusCounts/terminal/funnel/counters/gargalos sempre consideram todas as vendas do período+filtros,
 *       list retorna só a página pedida.
 *       startDate/endDate filtram por createdAt (data do pedido). comprador filtra diretamente por
 *       SaleData.buyerId; produto e vendedor filtram por boughtProducts e precisam bater na mesma linha
 *       do carrinho (o produto X vendido pelo vendedor Y). stage filtra só a list, pela etapa calculada
 *       (0-10) — use filterOptions.status pra montar esse valor sem hardcode. blocked=true filtra só a
 *       list, pra vendas com o selo "Bloqueada".
 *     tags: [Dashboard]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1, minimum: 1 }
 *         description: Página da lista detalhada (1-indexed)
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 20, maximum: 100 }
 *         description: Itens por página da lista detalhada (máx. 100)
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date-time }
 *         description: Filtra vendas com createdAt >= startDate (ISO 8601). Front computa os presets (hoje, 7/15/30 dias) e envia aqui.
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date-time }
 *         description: Filtra vendas com createdAt <= endDate (ISO 8601)
 *       - in: query
 *         name: produto
 *         schema: { type: string, format: uuid }
 *         description: Filtra por id do produto (ver filterOptions.produtos)
 *       - in: query
 *         name: comprador
 *         schema: { type: string, format: uuid }
 *         description: Filtra por id do comprador (ver filterOptions.compradores)
 *       - in: query
 *         name: vendedor
 *         schema: { type: string, format: uuid }
 *         description: Filtra por id do vendedor (ver filterOptions.vendedores)
 *       - in: query
 *         name: tipoOperacao
 *         schema: { type: string }
 *         description: >
 *           Aceito por paridade com os demais filtros, mas sem efeito hoje — não há campo no schema
 *           que represente "tipo de operação" (em standby até o cliente definir a fonte do dado).
 *           filterOptions.tiposOperacao sempre retorna [].
 *       - in: query
 *         name: stage
 *         schema: { type: string, example: "4,5,6" }
 *         description: >
 *           Lista de etapas separadas por vírgula (0-10; 0 = terminal Cancelado/Recusado) para filtrar só a lista detalhada.
 *           Use filterOptions.status[].stages pra montar esse valor sem hardcodar números de etapa no front.
 *           Se usado sem startDate, a busca fica limitada aos últimos 180 dias (janela máxima interna) para manter
 *           tempo de resposta estável — informe startDate explicitamente para consultar um período diferente.
 *       - in: query
 *         name: blocked
 *         schema: { type: boolean }
 *         description: Quando true, filtra só a lista detalhada para vendas com o selo "Bloqueada" (ver counters.bloqueadas).
 *     responses:
 *       200:
 *         description: Dados agregados do pipeline
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 statusCounts:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       stage: { type: integer, example: 4 }
 *                       key: { type: string, example: "colheita_embarque" }
 *                       label: { type: string, example: "Colheita realizada/Embarque" }
 *                       count: { type: integer, example: 5 }
 *                 terminal:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       stage: { type: integer, example: 0, description: "Sempre 0 — fora da esteira numerada 1-10" }
 *                       key: { type: string, example: "cancelado" }
 *                       label: { type: string, example: "Cancelado" }
 *                       count: { type: integer, example: 2 }
 *                 funnel:
 *                   type: array
 *                   description: 8 baldes cumulativos, na ordem do funil (Contrato Criado → Finalizada)
 *                   items:
 *                     type: object
 *                     properties:
 *                       key: { type: string, example: "em_transporte" }
 *                       label: { type: string, example: "Em Transporte" }
 *                       count: { type: integer, example: 6 }
 *                 counters:
 *                   type: object
 *                   properties:
 *                     operacoesAtivas: { type: integer, example: 19 }
 *                     finalizadas: { type: integer, example: 1 }
 *                     aguardandoPagamento: { type: integer, example: 11 }
 *                     bloqueadas: { type: integer, example: 6 }
 *                     taxaConversaoPercent: { type: number, example: 5.0 }
 *                     totalContratos: { type: integer, example: 20 }
 *                 gargalos:
 *                   type: object
 *                   properties:
 *                     aguardandoPagamento: { type: integer, example: 11 }
 *                     bloqueadas: { type: integer, example: 6 }
 *                     semDocumentos: { type: integer, example: 3 }
 *                     entregaAtrasada: { type: integer, example: 1 }
 *                 filterOptions:
 *                   type: object
 *                   properties:
 *                     produtos:
 *                       type: array
 *                       items: { type: object, properties: { id: { type: string, format: uuid }, name: { type: string } } }
 *                     compradores:
 *                       type: array
 *                       items: { type: object, properties: { id: { type: string, format: uuid }, name: { type: string } } }
 *                     vendedores:
 *                       type: array
 *                       items: { type: object, properties: { id: { type: string, format: uuid }, name: { type: string } } }
 *                     tiposOperacao:
 *                       type: array
 *                       items: { type: object }
 *                       description: Sempre [] — ver descrição do parâmetro tipoOperacao
 *                     status:
 *                       type: array
 *                       description: Opções do dropdown "Status" — usar `stages` (junte em ?stage=) ou `blocked` (?blocked=true) pra filtrar a list
 *                       items:
 *                         type: object
 *                         properties:
 *                           value: { type: string, example: "liberado_embarque" }
 *                           label: { type: string, example: "Liberado para Embarque" }
 *                           stages: { type: array, items: { type: integer }, example: [3, 4, 5] }
 *                           blocked: { type: boolean, example: true, description: "Presente só na opção 'Bloqueada'" }
 *                 list:
 *                   type: object
 *                   properties:
 *                     items:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id: { type: string, format: uuid }
 *                           orderNumber: { type: integer, example: 102 }
 *                           produto: { type: string, example: "Manga (+2)" }
 *                           comprador: { type: string, example: "Exportadora XPTO" }
 *                           vendedor: { type: string, example: "Coop X" }
 *                           valor: { type: number, example: 50000.0 }
 *                           status: { type: string, example: "Em Transporte" }
 *                           diasEtapa: { type: integer, example: 2 }
 *                     page: { type: integer, example: 1 }
 *                     pageSize: { type: integer, example: 20 }
 *                     total: { type: integer, example: 137 }
 *                     totalPages: { type: integer, example: 7 }
 *       400: { description: "page/pageSize/startDate/endDate/stage/blocked inválidos" }
 *       401: { description: Não autenticado }
 *       403: { description: Acesso restrito a administradores }
 */
router.get("/pipeline", controller.getPipelineOverview as RequestHandler);

/**
 * @swagger
 * /dashboard/alerts:
 *   get:
 *     summary: Alertas Operacionais — 4 regras de risco/atraso + contadores, categoria, criticidade, evolução mensal e lista acionável
 *     description: >
 *       Regras (semPagamentoAntesColheita, documentosPendentes, entregaAtrasada, pagamentoVencido):
 *       plannedHarvestDate passado sem entrada confirmada; shippedAt preenchido sem nota_fiscal enviada
 *       OU sem weightDocumentId (comprovante de pesagem); plannedDeliveryDate passado sem
 *       actualDeliveryDate; Payment pending há mais de 3 dias (mesma regra usada como "Bloqueada" no
 *       Pipeline). Vendas Canceladas/Recusadas ficam fora de todas as regras.
 *       counters.criticos/medios: contagem ATUAL (agora) das regras Financeiro/Documentação+Logística.
 *       counters.resolvidos: APROXIMAÇÃO sem tabela de histórico — infere resolução a partir de
 *       timestamps existentes (confirmação de pagamento, upload de documento, entrega registrada) dentro
 *       de startDate/endDate (default: últimos 30 dias se omitido). Menos preciso pra pagamentoVencido.
 *       counters.saudeOperacionalPercent: % de operações ATIVAS (etapa 1-9 do Pipeline) sem nenhum alerta
 *       das regras ativas no momento — (ativas sem alerta / total de ativas) × 100. null quando não há
 *       operação ativa no escopo filtrado. Não depende de histórico (ao contrário de counters.resolvidos).
 *       counts.semTermoAditivo: sempre 0 (standby — não há campo no schema pra "termo aditivo").
 *       evolucaoMensal: últimos 6 meses corridos (fixo, independente de startDate/endDate) — mesma
 *       aproximação de resolvidos, mais criticos/medios bucketados pela data em que cada alerta ainda
 *       aberto começou (não é um histórico exato de quantos estavam abertos EM cada mês passado).
 *       startDate/endDate filtram por createdAt (data do pedido) nas regras/contadores atuais — e definem
 *       a janela de "resolvidos" quando informados. categoria/criticidade filtram QUAIS regras entram na
 *       conta (fixas por tipo de regra). parceiro filtra por comprador OU vendedor da venda.
 *     tags: [Dashboard]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50, maximum: 200 }
 *         description: Máximo de itens retornados em list (as regras ativas combinadas, ordenadas por criticidade e depois por dias em aberto)
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date-time }
 *         description: Filtra vendas com createdAt >= startDate (ISO 8601); também define o início da janela de "resolvidos"
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date-time }
 *         description: Filtra vendas com createdAt <= endDate (ISO 8601); também define o fim da janela de "resolvidos"
 *       - in: query
 *         name: categoria
 *         schema: { type: string, enum: [Financeiro, Documentação, Logística, Contratual, Outros] }
 *         description: Filtra só as regras dessa categoria (ver filterOptions.categorias)
 *       - in: query
 *         name: criticidade
 *         schema: { type: string, enum: [Crítico, Médio, Baixo] }
 *         description: Filtra só as regras dessa criticidade (ver filterOptions.criticidades)
 *       - in: query
 *         name: parceiro
 *         schema: { type: string, format: uuid }
 *         description: Filtra por id do comprador OU vendedor da venda (ver filterOptions.parceiros)
 *     responses:
 *       200:
 *         description: Alertas operacionais atuais
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 counters:
 *                   type: object
 *                   properties:
 *                     criticos: { type: integer, example: 3 }
 *                     medios: { type: integer, example: 8 }
 *                     resolvidos: { type: integer, example: 15 }
 *                     bloqueadas: { type: integer, example: 6 }
 *                     saudeOperacionalPercent: { type: number, nullable: true, example: 87.0, description: "null quando não há operação ativa no escopo filtrado — ver descrição do endpoint" }
 *                 counts:
 *                   type: object
 *                   properties:
 *                     semPagamentoAntesColheita: { type: integer, example: 11 }
 *                     documentosPendentes: { type: integer, example: 3 }
 *                     entregaAtrasada: { type: integer, example: 2 }
 *                     bloqueadas: { type: integer, example: 6 }
 *                     semTermoAditivo: { type: integer, example: 0, description: "Sempre 0 — standby, ver descrição do endpoint" }
 *                 porCategoria:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       categoria: { type: string, example: "Financeiro" }
 *                       count: { type: integer, example: 6 }
 *                       percentual: { type: number, example: 42.9 }
 *                 evolucaoMensal:
 *                   type: array
 *                   description: Últimos 6 meses corridos — ver aproximação na descrição do endpoint
 *                   items:
 *                     type: object
 *                     properties:
 *                       month: { type: string, example: "2025-07" }
 *                       label: { type: string, example: "jul/2025" }
 *                       criticos: { type: integer, example: 3 }
 *                       medios: { type: integer, example: 8 }
 *                       resolvidos: { type: integer, example: 15 }
 *                 filterOptions:
 *                   type: object
 *                   properties:
 *                     categorias: { type: array, items: { type: string }, example: ["Financeiro", "Documentação", "Logística", "Contratual", "Outros"] }
 *                     criticidades: { type: array, items: { type: string }, example: ["Crítico", "Médio", "Baixo"] }
 *                     parceiros:
 *                       type: array
 *                       items: { type: object, properties: { id: { type: string, format: uuid }, name: { type: string } } }
 *                 list:
 *                   type: object
 *                   properties:
 *                     items:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id: { type: string, format: uuid }
 *                           orderNumber: { type: integer, example: 27 }
 *                           categoria: { type: string, example: "Financeiro" }
 *                           criticidade: { type: string, example: "Crítico" }
 *                           parceiro: { type: string, example: "Exportador X" }
 *                           descricao: { type: string, example: "Pagamento pendente vencido — aberto desde 28/07/2025." }
 *                           dataHora: { type: string, format: date-time }
 *                           diasEmAberto: { type: integer, example: 1 }
 *                           acao: { type: string, example: "Cobrar pagamento pendente" }
 *                           status: { type: string, example: "Aberto" }
 *                     total: { type: integer, example: 19, description: "Total de alertas abertos nas regras ativas — pode ser maior que items.length se exceder limit" }
 *                     limit: { type: integer, example: 50 }
 *       400: { description: "limit/startDate/endDate/categoria/criticidade inválidos" }
 *       401: { description: Não autenticado }
 *       403: { description: Acesso restrito a administradores }
 */
router.get("/alerts", controller.getOperationalAlerts as RequestHandler);

/**
 * @swagger
 * /dashboard/logistics:
 *   get:
 *     summary: Logística e Desempenho — tempo médio de entrega, % no prazo, atraso médio e desempenho por comprador/vendedor
 *     description: >
 *       Considera só vendas com actualDeliveryDate preenchido (efetivamente entregues), fora Canceladas/Recusadas.
 *       averageDeliveryDays: média de dias entre shippedAt e actualDeliveryDate (null se nenhuma venda tem shippedAt).
 *       onTimePercent/averageDelayDays: comparam actualDeliveryDate x plannedDeliveryDate (null se nenhuma venda
 *       tem plannedDeliveryDate); averageDelayDays considera só as entregas atrasadas (não conta as no prazo como 0).
 *       byBuyer/bySeller: mesma base de % no prazo, agrupada por comprador/vendedor (venda com múltiplos
 *       vendedores conta para cada um); alerta:true quando onTimePercent < 80%. Sem janela de tempo (histórico completo).
 *     tags: [Dashboard]
 *     responses:
 *       200:
 *         description: Indicadores logísticos atuais
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deliveredCount: { type: integer, example: 42 }
 *                 averageDeliveryDays: { type: number, nullable: true, example: 2.5 }
 *                 onTimePercent: { type: number, nullable: true, example: 82.0 }
 *                 averageDelayDays: { type: number, nullable: true, example: 1.8 }
 *                 byBuyer:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, format: uuid }
 *                       name: { type: string, example: "Comprador A" }
 *                       delivered: { type: integer, example: 20 }
 *                       onTimePercent: { type: number, example: 95.0 }
 *                       alerta: { type: boolean, example: false }
 *                 bySeller:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, format: uuid }
 *                       name: { type: string, example: "Coop Y" }
 *                       delivered: { type: integer, example: 8 }
 *                       onTimePercent: { type: number, example: 60.0 }
 *                       alerta: { type: boolean, example: true }
 *       401: { description: Não autenticado }
 *       403: { description: Acesso restrito a administradores }
 */
router.get("/logistics", controller.getLogisticsOverview as RequestHandler);

export default router;
