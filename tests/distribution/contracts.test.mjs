import { expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const document = JSON.parse(
  readFileSync(
    new URL('../../docs/contracts/v1.openapi.json', import.meta.url),
    'utf8',
  ),
);

const expectedDistributionOperations = {
  RequestExternalChange: 'reservation.external_change.request',
  CreateConnection: 'channel.connection.manage',
  ActivateConnection: 'channel.connection.manage',
  SaveMapping: 'channel.mapping.manage',
  PreviewExposure: 'channel.sale.manage',
  PublishExposure: 'channel.sale.manage',
  WithdrawExposure: 'channel.sale.manage',
  SetDistributionSaleStatus: 'channel.sale.manage',
  GetSyncStatus: 'channel.read',
  ReconcileConnection: 'channel.reconcile',
  ReprocessChannelEvent: 'channel.reprocess',
};

test('distribution operationIds and permissions stay compatible', () => {
  const actual = {};
  for (const item of Object.values(document.paths))
    for (const [method, operation] of Object.entries(item))
      if (
        ['get', 'post', 'put', 'patch', 'delete'].includes(method) &&
        Object.hasOwn(expectedDistributionOperations, operation.operationId)
      )
        actual[operation.operationId] = operation['x-permission'];
  expect(actual).toEqual(expectedDistributionOperations);
});

test('no distribution operation was added or renamed silently', () => {
  const operationIds = [];
  for (const item of Object.values(document.paths))
    for (const [method, operation] of Object.entries(item))
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        const permission = String(operation['x-permission'] ?? '');
        if (
          permission.startsWith('channel.') ||
          permission === 'reservation.external_change.request'
        )
          operationIds.push(operation.operationId);
      }
  expect(new Set(operationIds)).toEqual(
    new Set(Object.keys(expectedDistributionOperations)),
  );
});
