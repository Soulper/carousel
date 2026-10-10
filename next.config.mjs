/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { serverComponentsExternalPackages: ["puppeteer-core", "@sparticuz/chromium", "sharp"] },
};
export default nextConfig;
