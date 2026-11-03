# Viu, pediu

Projeto do Hackathon iFood: tire uma foto de um produto e peça pelo iFood sem precisar digitar.

O Gemini identifica o produto na imagem. Um chat permite corrigir a identificação, e o app compara até três ofertas reais do iFood para o seu endereço. Você revisa o carrinho (itens, taxas, descontos e total retornados pelo iFood) antes de confirmar o pedido.

## Estrutura

| Caminho | O que é |
| --- | --- |
| [Prototipo/](Prototipo/) | App web (React + Vite no front, Express no servidor) que integra Gemini e o MCP do iFood |
| [APIGemini.py](APIGemini.py) | Leitor de fotos em Python que envia a imagem ao Gemini e devolve produto, detalhes e termos de busca |
| [imagens/](imagens/) | Fotos de exemplo para testar a identificação |

Detalhes do fluxo de compra, regras de pagamento e testes estão em [Prototipo/README.md](Prototipo/README.md).

## Pré-requisitos

- Node.js 22.13 ou superior (usa o SQLite nativo do Node)
- Python 3.11 ou superior
- Uma chave da API do Gemini
- Um agente cadastrado no [portal de desenvolvedores iFood](https://mcp-developer.ifood.com.br/pt-BR/docs/guides), com `client_id` e `client_secret`

## Como rodar

Na raiz do repositório, crie o ambiente Python:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install google-genai python-dotenv Pillow
```

Instale o app e crie o arquivo de configuração:

```bash
cd Prototipo
npm install
cp .env.example .env
```

Preencha no `Prototipo/.env`:

- `GEMINI_API_KEY`
- `IFOOD_CLIENT_ID` e `IFOOD_CLIENT_SECRET`
- `IFOOD_SCOPES`, com os escopos habilitados para o seu agente

Inicie o servidor:

```bash
npm run dev
```

Abra **http://localhost:3000** e clique em **Conectar iFood**.

## Login com o iFood (callback OAuth)

O login só funciona se o redirect cadastrado no portal do iFood for **idêntico** ao `IFOOD_REDIRECT_URI` do `.env`, e se esse endereço apontar para o servidor do app. Com a configuração padrão:

```text
IFOOD_REDIRECT_URI=http://localhost:3000/api/auth/ifood/callback
```

- A porta precisa ser a mesma de `PORT` (padrão `3000`). Se mudar a porta, mude também o redirect no `.env` e no portal.
- O caminho precisa ser `/api/auth/ifood/callback`, que é a rota que o servidor atende.
- Abra o app por `localhost`, e não por `127.0.0.1`. Do contrário, o cookie de sessão se perde no retorno do login.

## Comandos úteis

Rode dentro de `Prototipo/`:

| Comando | O que faz |
| --- | --- |
| `npm run dev` | Sobe o servidor com o front em modo de desenvolvimento |
| `npm run lint` | Checa os tipos com TypeScript |
| `npm test` | Roda os testes do servidor, sem chamar Gemini nem iFood |
| `npm run test:e2e` | Roda os testes de interface no Chromium (antes, rode `npx playwright install chromium`) |
| `npm run build` | Gera o build de produção do front |

## Testar só o leitor de fotos

Na raiz, com o `.env` contendo `GEMINI_API_KEY`:

```bash
.venv/bin/python APIGemini.py imagens/pringles.png
```

## Cuidados

- Confirmar o pedido no app cria um **pedido real** na sua conta iFood. O pagamento aceito é Pix, e ele é feito no próprio iFood.
- As fotos são enviadas ao Gemini. Não envie imagens com informações que você não queira compartilhar.
- Nunca versione o `.env`. Ele já está no `.gitignore`.
