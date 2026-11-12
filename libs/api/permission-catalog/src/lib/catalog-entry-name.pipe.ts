import { CodedHttpException, t } from '@bge/i18n';
import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { Http } from '@status/codes';

/**
 * A permission's slug or a role's name, as a path parameter of the permission
 * catalog's routes (#772).
 *
 * A value holding NUL names no entry: Postgres stores no NUL in text, and
 * refuses a query that compares one, which would surface as a bare 500. So
 * it is answered before any query, as any name no entry has is: 404 with
 * `CATALOG_ENTRY_NOT_FOUND`, and the message of the entry the parameter
 * names, a role for `:name` and a permission for `:slug`.
 */
@Injectable()
export class CatalogEntryNamePipe implements PipeTransform<string, string> {
  transform(value: string, { data }: ArgumentMetadata): string {
    if (!value.includes('\u0000')) {
      return value;
    }

    throw new CodedHttpException(
      Http.NotFound,
      'CATALOG_ENTRY_NOT_FOUND',
      data === 'name'
        ? t('errors.permission_catalog.role_not_found', { name: value })
        : t('errors.permission_catalog.entry_not_found', { slug: value }),
    );
  }
}
