import { Injectable } from '@nestjs/common';

/** Relógio da farmácia: os testes fixam o instante para validar o "horário certo". */
@Injectable()
export class PharmacyClock {
  private fixed?: Date;

  now(): Date {
    return this.fixed ? new Date(this.fixed) : new Date();
  }

  set(date?: Date) {
    this.fixed = date;
  }
}
