import type { AppAbility } from './app-ability.type';

export interface IPolicyHandler {
  handle(ability: AppAbility, ...args: any[]): boolean;
}

type PolicyHandlerCallback = (ability: AppAbility, ...args: any[]) => boolean;

export type PolicyHandler = IPolicyHandler | PolicyHandlerCallback;
