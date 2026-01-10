import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DatabaseService } from './database.service.js';

describe('DatabaseService', () => {
  let service: DatabaseService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [DatabaseService],
      imports: [ConfigModule],
    }).compile();

    service = module.get(DatabaseService);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });
});
