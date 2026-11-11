import { Injectable } from '@nestjs/common';
import { CheckpointRepository } from '../repositories/checkpoint.repository';

/** Deprecated: lists challenges opened before the Challenge Map; no new ones are generated. */
@Injectable()
export class CheckpointService {
  constructor(private readonly repository: CheckpointRepository) {}

  list(userId: string) {
    return this.repository.listAvailable(userId);
  }
}
