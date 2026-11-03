import { expect, test, type Page } from '@playwright/test';
import type { SessionState } from '../shared/types';

// This suite exercises the prototype shell without connecting to any provider.
async function homeApi(page: Page) {
  const unexpected: string[] = [];
  const session: SessionState = { connected: true, configured: true, geminiConfigured: true, userName: 'Marina', addresses: [{ id: 'home-address', label: 'Casa', formatted: 'Rua das Flores, 100', latitude: -22.01, longitude: -47.89 }], selectedAddressId: 'home-address', orders: [], capabilities: [] };
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path === '/api/session') return route.fulfill({ json: session });
    if (request.method() === 'GET' && path === '/api/chat') return route.fulfill({ json: { id: 'home-conversation', messages: [], offers: [] } });
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 501, json: { message: 'API não prevista no teste offline.' } });
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => Promise.reject(new DOMException('Permissão negada', 'NotAllowedError')) } });
  });
  return unexpected;
}

test('início preserva o protótipo: fundo vermelho, boas-vindas e um botão central de câmera', async ({ page }) => {
  const unexpected = await homeApi(page);
  await page.goto('/');
  const cameraButton = page.getByRole('button', { name: 'Abrir câmera', exact: true });
  await expect(cameraButton).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Bem-vindo!', exact: true })).toBeVisible();
  await expect(page.locator('.home-screen').getByText('Viu, pediu', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Início', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Sua mensagem' })).not.toBeVisible();
  await expect(page.getByRole('region', { name: 'Opções encontradas' })).not.toBeVisible();
  const appearance = await cameraButton.evaluate(button => {
    const style = getComputedStyle(button), bounds = button.getBoundingClientRect();
    const radius = parseFloat(style.borderRadius) * (style.borderRadius.endsWith('%') ? bounds.width / 100 : 1);
    return { width: bounds.width, height: bounds.height, radius, background: style.backgroundColor };
  });
  expect(appearance.width).toBeGreaterThanOrEqual(120);
  expect(Math.abs(appearance.width - appearance.height)).toBeLessThanOrEqual(1);
  expect(appearance.radius).toBeGreaterThanOrEqual(appearance.width / 2 - 1);
  expect(appearance.background).toBe('rgb(255, 255, 255)');
  const homeColor = await page.locator('.home-screen').evaluate(home => {
    let node: Element | null = home;
    while (node) {
      const color = getComputedStyle(node).backgroundColor;
      if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color;
      node = node.parentElement;
    }
    return '';
  });
  const [red, green, blue] = homeColor.match(/\d+/g)!.map(Number);
  expect(red).toBeGreaterThan(180); expect(green).toBeLessThan(90); expect(blue).toBeLessThan(100);
  await cameraButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Não foi possível abrir a câmera/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enviar foto da galeria', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Sua mensagem' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bem-vindo!', exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Início', exact: true }).click();
  await expect(cameraButton).toBeVisible();
  expect(unexpected).toEqual([]);
});

for (const viewport of [{ width: 360, height: 780 }, { width: 768, height: 900 }, { width: 1440, height: 900 }, { width: 1440, height: 600 }]) {
  test(`retângulo mobile e navegação cabem em ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const unexpected = await homeApi(page);
    await page.goto('/');
    const camera = page.getByRole('button', { name: 'Abrir câmera', exact: true });
    await expect(camera).toBeEnabled();
    const frame = page.locator('.app-shell');
    const bounds = await frame.boundingBox();
    expect(bounds).toBeTruthy();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(bounds!.width).toBeLessThanOrEqual(420);
    if (viewport.width >= 768) expect(bounds!.width).toBeGreaterThanOrEqual(390);
    expect(bounds!.height).toBeGreaterThan(bounds!.width * 1.3);
    const cameraBounds = await camera.boundingBox(); expect(cameraBounds).toBeTruthy();
    expect(Math.abs(cameraBounds!.x + cameraBounds!.width / 2 - (bounds!.x + bounds!.width / 2))).toBeLessThanOrEqual(2);
    for (const element of [camera, page.getByRole('button', { name: 'Início', exact: true }), page.getByRole('button', { name: 'Chat', exact: true })]) {
      const elementBounds = await element.boundingBox();
      expect(elementBounds).toBeTruthy();
      expect(elementBounds!.x).toBeGreaterThanOrEqual(bounds!.x);
      expect(elementBounds!.y).toBeGreaterThanOrEqual(bounds!.y);
      expect(elementBounds!.x + elementBounds!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
      expect(elementBounds!.y + elementBounds!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height + 1);
    }
    const documentSize = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
    expect(documentSize.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(documentSize.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(unexpected).toEqual([]);
  });
}
