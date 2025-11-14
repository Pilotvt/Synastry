#!/usr/bin/env node
import { generateLicenseKey } from '../electron/license.js';

function printUsage() {
  console.log('Usage: npm run generate:license -- <owner> [daysValid]');
 console.log('  owner      — email пользователя (будет проверяться при активации)');
  console.log('  daysValid  — количество дней действия (по умолчанию 365)');
}

async function main() {
  const [, , ownerArg, daysArg] = process.argv;
  if (!ownerArg) {
    printUsage();
    process.exit(1);
  }

  const days = daysArg ? Number(daysArg) : 365;
  if (Number.isNaN(days) || days <= 0) {
    console.error('daysValid должен быть положительным числом.');
    process.exit(1);
  }

  try {
    const key = generateLicenseKey(ownerArg, days);
    console.log('\n=== Generated License Key ===');
    console.log(`Owner: ${ownerArg}`);
    console.log(`Valid days: ${days}`);
    console.log(`Key: ${key}`);
    console.log('\nСкопируйте ключ и передайте клиенту.');
  } catch (error) {
    console.error('Ошибка генерации ключа:', error);
    process.exit(1);
  }
}

await main();
