import { Test, TestingModule } from '@nestjs/testing';
import { SyncService, HorizonContractEvent } from './sync.service';
import { PoolsService } from '../pools/pools.service';
import { DonationsService } from '../donations/donations.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SyncState } from './sync-state.entity';

describe('SyncService', () => {
  let service: SyncService;
  const upsertFromChain = jest.fn();
  const markCompleted = jest.fn();
  const isTxProcessed = jest.fn();
  const recordDonation = jest.fn();
  const incrementRaised = jest.fn();
  const syncStateRepo = { findOne: jest.fn(), save: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncService,
        { provide: PoolsService, useValue: { upsertFromChain, markCompleted } },
        {
          provide: DonationsService,
          useValue: { isTxProcessed, recordDonation, incrementRaised },
        },
        { provide: getRepositoryToken(SyncState), useValue: syncStateRepo },
      ],
    }).compile();

    service = module.get(SyncService);
    upsertFromChain.mockReset();
    markCompleted.mockReset();
    isTxProcessed.mockReset().mockResolvedValue(false);
    recordDonation.mockReset().mockResolvedValue(undefined);
    incrementRaised.mockReset().mockResolvedValue(undefined);
    syncStateRepo.findOne.mockReset();
    syncStateRepo.save.mockReset();
  });

  it('extracts contractPoolId, creatorWallet, and goal and calls upsertFromChain', async () => {
    const event: HorizonContractEvent = {
      topic: ['pool_crtd', 'pool-42'],
      value: ['GABC123', '50000', 'My Pool', 'A great pool'],
    };

    await service.processPoolCreatedEvent(event);

    expect(upsertFromChain).toHaveBeenCalledWith({
      contractPoolId: 'pool-42',
      creatorWallet: 'GABC123',
      goal: '50000',
    });
  });

  describe('cursor persistence', () => {
    it('getCursor returns null when no cursor has been set', () => {
      expect(service.getCursor()).toBeNull();
    });

    it('saveCursor persists the cursor value and updates in-memory state', async () => {
      syncStateRepo.save.mockResolvedValue({
        key: 'horizon_cursor',
        value: 'cursor-42',
      });

      await service.saveCursor('cursor-42');

      expect(service.getCursor()).toBe('cursor-42');
      expect(syncStateRepo.save).toHaveBeenCalledWith({
        key: 'horizon_cursor',
        value: 'cursor-42',
      });
    });

    it('saveCursor overwrites a previously set cursor', async () => {
      syncStateRepo.save.mockResolvedValue({
        key: 'horizon_cursor',
        value: 'cursor-first',
      });
      await service.saveCursor('cursor-first');

      syncStateRepo.save.mockResolvedValue({
        key: 'horizon_cursor',
        value: 'cursor-second',
      });
      await service.saveCursor('cursor-second');

      expect(service.getCursor()).toBe('cursor-second');
      expect(syncStateRepo.save).toHaveBeenCalledTimes(2);
    });

    it('onModuleInit restores the cursor from the database on startup', async () => {
      syncStateRepo.findOne.mockResolvedValue({
        key: 'horizon_cursor',
        value: 'restored-cursor',
      });

      await service.onModuleInit();

      expect(syncStateRepo.findOne).toHaveBeenCalledWith({
        where: { key: 'horizon_cursor' },
      });
      expect(service.getCursor()).toBe('restored-cursor');
    });

    it('onModuleInit leaves cursor null when no state exists in the database', async () => {
      syncStateRepo.findOne.mockResolvedValue(null);

      await service.onModuleInit();

      expect(service.getCursor()).toBeNull();
    });

    it('onModuleInit queries findOne with the horizon_cursor key and restores the value', async () => {
      syncStateRepo.findOne.mockResolvedValue({
        key: 'horizon_cursor',
        value: 'restored-cursor',
      });

      await service.onModuleInit();

      expect(syncStateRepo.findOne).toHaveBeenCalledWith({
        where: { key: 'horizon_cursor' },
      });
      expect(service.getCursor()).toBe('restored-cursor');
    });

    it('onModuleInit keeps the cursor null when findOne resolves null', async () => {
      syncStateRepo.findOne.mockResolvedValue(null);

      await service.onModuleInit();

      expect(syncStateRepo.findOne).toHaveBeenCalledWith({
        where: { key: 'horizon_cursor' },
      });
      expect(service.getCursor()).toBeNull();
    });

    it('onModuleInit does not overwrite an already-set cursor incorrectly', async () => {
      syncStateRepo.save.mockResolvedValue({
        key: 'horizon_cursor',
        value: 'existing-cursor',
      });
      await service.saveCursor('existing-cursor');

      syncStateRepo.findOne.mockResolvedValue({
        key: 'horizon_cursor',
        value: 'restored-cursor',
      });
      await service.onModuleInit();

      expect(service.getCursor()).toBe('restored-cursor');
    });

    it('onModuleInit ignores a row with a different key', async () => {
      syncStateRepo.findOne.mockResolvedValue(null);

      await service.onModuleInit();

      expect(syncStateRepo.findOne).toHaveBeenCalledWith({
        where: { key: 'horizon_cursor' },
      });
      expect(service.getCursor()).toBeNull();
    });
  });

  describe('processPoolClosedEvent', () => {
    it('extracts contractPoolId from topic and calls markCompleted', async () => {
      const event: HorizonContractEvent = {
        topic: ['pool_cls', 'pool-99'],
        value: [],
      };

      await service.processPoolClosedEvent(event);

      expect(markCompleted).toHaveBeenCalledWith('pool-99');
    });

    it('calls markCompleted with the correct id for different pool ids', async () => {
      const event: HorizonContractEvent = {
        topic: ['pool_cls', 'pool-7'],
        value: [],
      };

      await service.processPoolClosedEvent(event);

      expect(markCompleted).toHaveBeenCalledTimes(1);
      expect(markCompleted).toHaveBeenCalledWith('pool-7');
    });
  });

  describe('idempotency', () => {
    it('skips processPoolCreatedEvent when tx is already in DB', async () => {
      isTxProcessed.mockResolvedValue(true);
      const event: HorizonContractEvent = {
        topic: ['pool_crtd', 'pool-1'],
        value: ['GABC', '100'],
        txHash: 'abc123',
      };

      await service.processPoolCreatedEvent(event);

      expect(upsertFromChain).not.toHaveBeenCalled();
    });

    it('skips processPoolClosedEvent when tx is already in DB', async () => {
      isTxProcessed.mockResolvedValue(true);
      const event: HorizonContractEvent = {
        topic: ['pool_cls', 'pool-1'],
        value: [],
        txHash: 'abc123',
      };

      await service.processPoolClosedEvent(event);

      expect(markCompleted).not.toHaveBeenCalled();
    });

    it('processes event when txHash is new', async () => {
      isTxProcessed.mockResolvedValue(false);
      const event: HorizonContractEvent = {
        topic: ['pool_crtd', 'pool-2'],
        value: ['GXYZ', '200'],
        txHash: 'newhash',
      };

      await service.processPoolCreatedEvent(event);

      expect(upsertFromChain).toHaveBeenCalledTimes(1);
    });

    it('warns and skips on duplicate txHash within the same run', async () => {
      const loggerWarnSpy = jest
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        .spyOn((service as any).logger, 'warn')
        .mockImplementation(() => {});
      const event: HorizonContractEvent = {
        topic: ['pool_crtd', 'pool-3'],
        value: ['GDUP', '300'],
        txHash: 'dup-hash',
      };

      await service.processPoolCreatedEvent(event);
      await service.processPoolCreatedEvent(event);

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('dup-hash'),
      );
      expect(upsertFromChain).toHaveBeenCalledTimes(1);
    });

    it('processes event without txHash (no idempotency check)', async () => {
      const event: HorizonContractEvent = {
        topic: ['pool_crtd', 'pool-4'],
        value: ['GNOHASH', '400'],
      };

      await service.processPoolCreatedEvent(event);

      expect(isTxProcessed).not.toHaveBeenCalled();
      expect(upsertFromChain).toHaveBeenCalledTimes(1);
    });
  });

  describe('processDonationEvent', () => {
    it('skips when txHash is missing', async () => {
      const event: HorizonContractEvent = {
        topic: ['donation', 'pool-1'],
        value: ['GDONOR', '100'],
      };

      await service.processDonationEvent(event);

      expect(isTxProcessed).not.toHaveBeenCalled();
      expect(recordDonation).not.toHaveBeenCalled();
      expect(incrementRaised).not.toHaveBeenCalled();
    });

    it('skips when isTxDuplicate returns true', async () => {
      isTxProcessed.mockResolvedValue(true);
      const event: HorizonContractEvent = {
        topic: ['donation', 'pool-1'],
        value: ['GDONOR', '100'],
        txHash: 'dup-donation-hash',
      };

      await service.processDonationEvent(event);

      expect(recordDonation).not.toHaveBeenCalled();
      expect(incrementRaised).not.toHaveBeenCalled();
    });

    it('handles a DB-level unique violation gracefully when a race slips past isTxDuplicate', async () => {
      isTxProcessed.mockResolvedValue(false);
      const uniqueViolation = Object.assign(
        new Error('duplicate key value violates unique constraint'),
        { code: '23505' },
      );
      recordDonation.mockRejectedValue(uniqueViolation);
      const event: HorizonContractEvent = {
        topic: ['donation', 'pool-1'],
        value: ['GDONOR', '100'],
        txHash: 'race-hash',
      };

      await expect(service.processDonationEvent(event)).resolves.not.toThrow();

      expect(recordDonation).toHaveBeenCalledTimes(1);
      expect(incrementRaised).not.toHaveBeenCalled();
    });
  });
});
