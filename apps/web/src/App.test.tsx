import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { App } from './App.js';

describe('App', () => {
  it('renders the shell', () => {
    const html = renderToString(<App />);
    expect(html).toContain('Rode');
    expect(html).toContain('connecting');
  });
});
