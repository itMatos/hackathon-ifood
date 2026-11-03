# Viu, pediu

MVP web: envie uma foto, corrija a identificação pelo chat, compare opções reais do iFood e revise o carrinho antes de confirmar o pedido. A interface segue o protótipo mobile do documento `Hackaton ifood.pdf`: retângulo vertical, início vermelho minimalista com botão circular de câmera, captura e chat com cartões de produtos. A navegação em pílula alterna entre Início e Chat; conta, endereço e pedidos ficam no menu. O leitor original de fotos permanece em `../APIgemini.py`; o servidor Express integra Python, Gemini e MCP.

## Executar localmente

Requer Node.js 22.13 ou superior (SQLite nativo), npm e Python 3.11 ou superior.

Na raiz do projeto:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cd Prototipo
npm install
cp .env.example .env
```

Preencha `GEMINI_API_KEY`, `IFOOD_CLIENT_ID` e `IFOOD_CLIENT_SECRET` em `.env`. As credenciais OAuth precisam pertencer a um agente cadastrado no [portal de desenvolvedores iFood](https://mcp-developer.ifood.com.br/pt-BR/docs/guides). Cadastre exatamente este callback no agente:

```text
http://localhost:3000/api/auth/ifood/callback
```

Inicie a aplicação e abra **http://localhost:3000**:

```bash
npm run dev
```

Use `localhost` também no navegador para preservar o cookie durante o retorno OAuth. O servidor escuta em `127.0.0.1` por padrão. Não é necessário publicar a aplicação para usar o callback local se ele estiver autorizado no cadastro do agente.

Configurações são carregadas de `Prototipo/.env`, `Prototipo/.env.local` e `.env` da raiz, nesta ordem; variáveis já definidas no ambiente prevalecem. Não coloque credenciais em variáveis `VITE_*`, no frontend ou em arquivos versionados. `PYTHON_BIN=../.venv/bin/python` considera a execução a partir de `Prototipo/`.

## Conta iFood e fluxo real

Clique em **Conectar iFood**, autorize o agente e selecione um dos endereços retornados pela conta. Uma autorização feita em outro cliente não conecta automaticamente esta aplicação: ela usa seu próprio fluxo OAuth com PKCE, credenciais do agente e callback local. Tokens ficam no servidor.

O gateway configurado por padrão é `https://consumer-mcp.ifood.com.br/marketplace`. A disponibilidade de ferramentas depende do acesso e dos escopos concedidos ao agente. Ajuste `IFOOD_SCOPES` aos escopos habilitados no cadastro. Sem credenciais ou ferramentas necessárias, a aplicação apresenta a limitação; não cria catálogo, preço, cupom ou confirmação fictícios.

Envie JPEG, PNG ou WebP com até **10 MiB e 40 megapixels**. A imagem é validada e enviada ao Gemini pelo leitor Python; o arquivo temporário local é removido após a análise. A identificação fornece nome, detalhes visíveis e até três buscas, sem preencher marca ou tamanho desconhecidos. Imagens ambíguas pedem esclarecimento. Fotos são processadas pelo Gemini; não envie informações que você não queira compartilhar com esse provedor.

A busca considera o endereço escolhido. Selecione uma oferta, preencha complementos obrigatórios quando houver e revise itens, quantidade, entrega, taxas, descontos, mínimo e total retornados pelo iFood. O chat ajuda a pesquisar e comparar; a compra exige o botão de confirmação da revisão atual. Mudanças de preço ou carrinho exigem revisão novamente.

Os resultados são limitados às três opções mais relevantes, priorizando alternativas de lojas diferentes. Quando o item permite cotação sem escolhas obrigatórias, a busca prepara carrinhos para consultar entrega, taxas e cupons e mostra o total efetivamente retornado. A cotação não envia pedidos. Quando faltam complementos, Pix ou valores do iFood, o cartão informa a pendência em vez de inventar um preço final. O carrinho cotado é reaproveitado na revisão da opção escolhida.

O MVP aceita **PIX**. Confirmar cria um pedido real quando o iFood aceita a solicitação; o pagamento continua no iFood. A aplicação não paga automaticamente nem marca o pedido como pago por conta própria. O status exibido é o recebido do iFood. Em uma resposta incerta após envio, não repita a compra: verifique o pedido na conta antes de tentar de novo.

Carrinhos preparados pertencem à conta e podem permanecer no iFood mesmo quando a aplicação é fechada. A aplicação não completa o pedido mínimo adicionando produtos por conta própria.

## Validação e produção local

```bash
npm run lint
npm test
npm run test:python
npm run build
NODE_ENV=production npm start
```

Os testes usam respostas controladas somente dentro das suítes: não fazem chamadas a Gemini/iFood, não autenticam contas e não enviam pedidos reais. Em ambientes que bloqueiam o IPC do CLI `tsx`, o comando equivalente é `node --import tsx --test tests/*.test.ts`.

Para testar a interface no Chromium, incluindo upload, conversa, complementos, revisão Pix, erros e telas de 360, 768 e 1440 px:

```bash
npx playwright install chromium
npm run test:e2e
```

Os testes de navegador interceptam todas as rotas da API com respostas locais e não enviam pedidos à sua conta. O navegador pode exigir as bibliotecas de sistema indicadas pelo Playwright. A validação com credenciais reais deve parar na revisão do carrinho; o envio real acontece somente na confirmação explícita da aplicação. Não há garantia de que um pedido Pix fique apenas pendente, e a aplicação não executa seu pagamento.

O leitor também pode ser usado diretamente a partir da raiz:

```bash
.venv/bin/python APIgemini.py "foto.jpg"
.venv/bin/python APIgemini.py --json --mime-type image/jpeg "foto.jpg"
```

O modo JSON escreve somente o resultado em `stdout`; falhas escrevem o diagnóstico em `stderr` e encerram com código diferente de zero. A ponte limita análise a 45 segundos e saída do processo a 64 KiB. `GEMINI_VISION_MODEL` e `GEMINI_CHAT_MODEL` podem selecionar modelos disponíveis para sua chave; o padrão é `gemini-3.8-flash`, sem substituição silenciosa.

O processo usa SQLite em `Prototipo/data/viu-pediu.sqlite` para conversas e registro local dos pedidos. Credenciais e sessões OAuth permanecem na memória e exigem reconexão após reiniciar. `DATABASE_PATH` permite mudar a localização do banco. O servidor é destinado ao MVP local; uma publicação compartilhada requer configuração própria de HTTPS, origem e callback.
