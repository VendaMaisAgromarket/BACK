import app from './app';
import { PrismaClient } from '@prisma/client';
import './modules/price-recommendation/syncPricesJob';
import './modules/product/deactivateExpiredProductsJob';

const prisma = new PrismaClient();
const PORT = process.env.PORT || 5000;

async function main() {
  try {
    await prisma.$connect();
    console.log('Database connected successfully');

    app.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Database connection error', error);
    process.exit(1);
  }
}

main();