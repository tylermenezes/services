import Nano, { DocumentGetResponse } from 'nano';
import debug from 'debug';

const DEBUG = debug('services:clients:CouchDb');


export class CouchDb {
  private nano: Nano.DocumentScope<unknown>;

  constructor(url: string, db: string) {
    this.nano = Nano(url).use(db);
  }

  async write<T extends object>(_id: string, doc: T) {
    DEBUG(`INSERT ${_id}: ${JSON.stringify(doc)}`);
    await this.nano.insert({ ...doc, _id });
  }

  async overwrite<T extends object>(_id: string, doc: T) {
    let _rev: string | undefined = undefined;

    try {
      const existingDocument = await this.nano.get(_id);
      _rev = existingDocument._rev;
    } catch (ex) {}

    await this.write(_id, { _rev, ...doc });
  }

  async set<T extends object, U = T>(_id: string, partialDoc: T): Promise<U> {
    let existingDocument: DocumentGetResponse | undefined = undefined;
    try {
      existingDocument = await this.nano.get(_id);
    } catch (ex) {}

    await this.write(_id, { ...existingDocument, ...partialDoc });
    return this.nano.get(_id) as U;
  }

  async setKey(_id: string, key: string, value: string | number | null | undefined) {
    await this.set(_id, { [key]: value });
  }

  async read<T extends object = object>(_id: string, defaultValue?: T): Promise<T> {
    DEBUG(`GET ${_id}`);
    try {
      return await this.nano.get(_id) as T;
    } catch (ex) {
      DEBUG(`... not found, returning default ${JSON.stringify(defaultValue)}`);
      return defaultValue as T;
    }
  }

  async readKey<T>(_id: string, key: string, defaultValue?: T): Promise<T> {
    DEBUG(`GET ${_id}.${key}`);
    try {
      return (await this.nano.get(_id) as any)[key] || defaultValue;
    } catch (ex) {
      DEBUG(`... not found, returning default ${defaultValue}`);
      return defaultValue as T;
    }
  }

  async delete(_id: string) {
    await this.set(_id, { _deleted: true });
  }

  async increment(_id: string, key: string, quantity: number = 1): Promise<number> {
    let existingDocument: DocumentGetResponse | undefined = undefined;
    let existingValue: number = 0;
    try {
      const res = await this.nano.get(_id) as any;
      if (key in res && typeof res[key] === 'number') existingValue = res[key];
      existingDocument = res;
    } catch (ex) {}

    await this.nano.insert({ ...existingDocument, [key]: existingValue + quantity });
    return existingValue + quantity;
  }
}