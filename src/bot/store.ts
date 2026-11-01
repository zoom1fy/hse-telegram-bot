import { Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';

@Injectable()
export class Store {
  private readonly path = process.env.STORE_PATH ?? 'subscribers.json';
  private ids = new Set<number>();
  private loaded = false;

  async all(): Promise<number[]> {
    await this.load();
    return [...this.ids];
  }

  async has(id: number): Promise<boolean> {
    await this.load();
    return this.ids.has(id);
  }

  async add(id: number): Promise<void> {
    await this.load();
    this.ids.add(id);
    await this.save();
  }

  async remove(id: number): Promise<void> {
    await this.load();
    this.ids.delete(id);
    await this.save();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.path, 'utf8');
      const arr = JSON.parse(raw) as number[];
      this.ids = new Set(arr);
    } catch {
      this.ids = new Set<number>();
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await fs.writeFile(this.path, JSON.stringify([...this.ids]));
  }
}
