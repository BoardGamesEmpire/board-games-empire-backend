import { CodedHttpException, t } from '@bge/i18n';
import { Http } from '@status/codes';

/**
 * A plugin DataGateway's row has no connection address, port or credentials:
 * the coordinator builds its driver itself. A body that names one, even as
 * null, is refused before anything is written (#1083).
 */
export function pluginConnectionFields(): CodedHttpException {
  return new CodedHttpException(
    Http.UnprocessableEntity,
    'DATA_GATEWAY_PLUGIN_CONNECTION_FIELDS',
    t('errors.data_gateway.plugin_connection_fields'),
  );
}

/** A remote DataGateway is reached through its connection fields, so none of them can be cleared (#1083). */
export function connectionFieldRequired(): CodedHttpException {
  return new CodedHttpException(
    Http.UnprocessableEntity,
    'DATA_GATEWAY_CONNECTION_FIELD_REQUIRED',
    t('errors.data_gateway.connection_field_required'),
  );
}

/**
 * A plugin DataGateway's row can't be deleted: uninstalling its plugin
 * disables it and keeps it, since the game sources imported through it hang
 * on it, and a reinstall enables it again (#1083).
 */
export function pluginRowDelete(): CodedHttpException {
  return new CodedHttpException(
    Http.Conflict,
    'DATA_GATEWAY_PLUGIN_ROW_DELETE',
    t('errors.data_gateway.plugin_row_delete'),
  );
}
