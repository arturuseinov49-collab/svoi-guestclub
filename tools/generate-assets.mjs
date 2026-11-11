import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
const mark = `<path d="M511 710C496 571 534 428 634 321" fill="none" stroke="#DAFF35" stroke-width="18" stroke-linecap="round"/><path d="M516 568C348 555 314 423 341 323C475 327 555 416 516 568Z" fill="#DAFF35"/><path d="M539 491C524 353 626 264 741 278C747 406 680 511 539 491Z" fill="#BCA4F8"/><path d="M520 648C560 502 675 453 780 493C739 612 643 688 520 648Z" fill="#DAFF35"/><path d="M734 242L743 269L770 278L743 287L734 314L725 287L698 278L725 269Z" fill="#DAFF35"/>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="#171916"/><g transform="translate(-50 10)">${mark}</g></svg>`;
await writeFile('assets/icon.svg', svg);
await sharp(Buffer.from(svg)).png().toFile('assets/icon.png');
await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">${mark}</svg>`)).png().toFile('assets/android-icon-foreground.png');
await sharp(Buffer.from(svg)).resize(64).png().toFile('assets/favicon.png');
console.log('Brand assets generated.');
