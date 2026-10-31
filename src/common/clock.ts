import { Injectable } from '@nestjs/common';

@Injectable()
export class Clock {
  now() {
    return new Date();
  }
}
