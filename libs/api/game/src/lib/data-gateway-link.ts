/**
 * A game's DataGateway link: the DataGateway, and the game's external ID
 * there. Listing a game's expansions asks each DataGateway by it (#1067).
 */
export interface DataGatewayLink {
  gatewayId: string;
  externalId: string;
}
