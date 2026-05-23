import * as bcrypt from 'bcrypt';

const BCRYPT_COST = 12;

export default function hash(password: string): string {
  return bcrypt.hashSync(password, BCRYPT_COST);
}
