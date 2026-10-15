# Notificações in-app — o que o frontend precisa fazer

O backend gera as notificações sozinho. O front só **lista, mostra o contador e marca como lidas**. Nenhum endpoint existente mudou de contrato.

## 1. Endpoints (todos exigem `Authorization: Bearer <token>`)

| Método | Rota | Uso |
|---|---|---|
| `GET` | `/notifications?limit=20&cursor=<id>&unreadOnly=true` | Lista (mais recentes primeiro). `limit` 1–50 (padrão 20). `cursor` = `nextCursor` da página anterior. |
| `GET` | `/notifications/unread-count` | `{ "count": 3 }`: badge do sino |
| `PATCH` | `/notifications/:id/read` | `204`. É idempotente. `404` se a notificação não existir ou for de outro usuário. |
| `PATCH` | `/notifications/read-all` | `{ "updated": 5 }` |

Resposta de `GET /notifications`:

```json
{
  "items": [
    {
      "id": "uuid",
      "type": "NEW_ORDER",
      "title": "Novo pedido recebido",
      "message": "Você recebeu o pedido #123 de Fulano. Acesse para aceitar ou recusar.",
      "saleId": "uuid",
      "productId": null,
      "data": { "role": "seller", "orderNumber": 123 },
      "readAt": null,
      "createdAt": "2026-10-14T13:00:00.000Z"
    }
  ],
  "nextCursor": "uuid-ou-null",
  "unreadCount": 3
}
```

`title` e `message` já vêm prontos em pt-BR. O front pode exibi-los direto, sem montar texto.

## 2. Tipos e para onde navegar ao clicar

`data.role` diz de qual lado o usuário está (`buyer` ou `seller`). Use esse campo para escolher a tela, junto com `saleId` (notificações de venda) ou `productId` (lembrete de colheita do anúncio).

| `type` | Quem recebe | Quando | Destino sugerido | Campos extras em `data` |
|---|---|---|---|---|
| `NEW_ORDER` | vendedor | pedido criado | detalhe da venda (vendedor), com ação aceitar/recusar | — |
| `ORDER_ACCEPTED` | comprador | vendedor aceitou | detalhe da compra (próximo passo: pagar a entrada) | `status` |
| `ORDER_REJECTED` | comprador | vendedor recusou | detalhe da compra | `status` |
| `DOWN_PAYMENT_RECEIVED` | vendedor | entrada (30%) confirmada | detalhe da venda | `phase`, `amount`, `status` |
| `WEIGHT_REGISTERED` | comprador | vendedor registrou a pesagem | detalhe da compra / pagamento final (70%) | `weightKg`, `adjustedContractTotal` (pode ser `null`), `status` |
| `FINAL_PAYMENT_RECEIVED` | vendedor | parcela final (70%) ou pagamento integral confirmado | detalhe da venda | `phase` (`final_payment` ou `full`), `amount`, `status` |
| `ORDER_STATUS_CHANGED` | comprador | qualquer outra mudança de status (Entrada confirmada, Colheita autorizada, Entregue, Concluído, Cancelado…) | detalhe da compra | `status` |
| `ORDER_STATUS_CHANGED` | vendedor | só quando o pedido fica **Entregue** ou **Concluído** (por aceite tácito ou pelo admin). Se a conclusão vier do pagamento final, ela já aparece na mensagem de `FINAL_PAYMENT_RECEIVED`, sem notificação extra. | detalhe da venda | `status` |
| `PRODUCT_HARVEST_REMINDER` | vendedor | job diário às 08:00 de Brasília: anúncio ativo, com estoque, cuja colheita (`harvestAt`) está a até 5 dias. Depois dessa data o anúncio é desativado automaticamente. | edição do anúncio (`productId`), para prorrogar a colheita ou ajustar preço/estoque | `productId`, `harvestAt` (ISO), `daysLeft` (sem `saleId`/`orderNumber`) |

As notificações de venda trazem `saleId` e `data.orderNumber`; o lembrete de colheita traz `productId`. Trate tipos desconhecidos com um ícone genérico e navegue por `saleId` ou `productId` (o que vier preenchido), para que um tipo novo no back não quebre o front.

## 3. Componentes

1. **Sino no header** (usuário logado): badge com `unreadCount`. Esconda o badge quando for 0 e mostre "99+" acima disso.
2. **Dropdown/painel** ao clicar no sino: as últimas ~10 (`GET /notifications?limit=10`). Itens não lidos (`readAt === null`) ficam destacados. Mostre o tempo relativo a partir de `createdAt` ("há 5 min"). Inclua o botão "Marcar todas como lidas" (`PATCH /notifications/read-all`) e o link "Ver todas".
3. **Página `/notificacoes`**: lista paginada com "carregar mais" ou scroll infinito usando `nextCursor`, e o filtro "Não lidas" (`unreadOnly=true`).
4. **Clique numa notificação**: chame `PATCH /notifications/:id/read` sem bloquear a navegação (otimista: atualize `readAt` e decremente o badge localmente), depois navegue conforme a tabela da seção 2.
5. *(Opcional)* Toast quando o polling trouxer um `unreadCount` maior que o anterior.

## 4. Atualização (polling)

Ainda não há WebSocket nem SSE. Use polling:

- `GET /notifications/unread-count` a cada **30–60 s**, só com a aba visível (`document.visibilityState === 'visible'`). Refaça a chamada ao focar a aba e logo após o login.
- Recarregue a lista do dropdown ao abri-lo, não a cada ciclo do polling.
- Pare o polling no logout e ao receber `401`.
- Depois de ações do próprio usuário que geram notificação para ele mesmo, antecipe o refetch. Exemplo: o comprador autoriza a colheita e recebe `ORDER_STATUS_CHANGED`.

Com React Query ou SWR: `refetchInterval: 30000` com `refetchIntervalInBackground: false`. Invalide `['notifications']` após `read`/`read-all`.

## 5. Detalhes importantes

- **Datas**: `createdAt` e `harvestAt` vêm em UTC (ISO). Exiba em `America/Sao_Paulo`.
- **CORS**: o back agora inclui `PATCH` em `Access-Control-Allow-Methods`. Antes não incluía, e chamadas `PATCH` feitas do navegador eram bloqueadas no preflight.
- **Sem duplicatas**: o back deduplica eventos de pagamento e lembretes de colheita. O front não precisa deduplicar.
- **Momento do `NEW_ORDER`**: é gerado na criação da venda (`POST /sales`), não no aceite do contrato no checkout (decisão do negócio).
- **Venda ou anúncio excluído**: as notificações ligadas a eles também são apagadas (cascade). Se um `saleId`/`productId` retornar 404, mostre uma mensagem amigável.

## 6. Checklist

- [ ] Serviço de API: `listNotifications`, `getUnreadCount`, `markAsRead`, `markAllAsRead`
- [ ] Tipos TS: `NotificationType` (union dos 8 valores) e `Notification`
- [ ] Sino com badge, com polling ligado à visibilidade da aba
- [ ] Dropdown com as últimas notificações e "marcar todas como lidas"
- [ ] Página `/notificacoes` com paginação por cursor e filtro "não lidas"
- [ ] Mapa `type` + `data.role` → rota de destino (venda, compra ou edição do anúncio)
- [ ] Estados de vazio, loading e erro
- [ ] Datas no fuso de Brasília
