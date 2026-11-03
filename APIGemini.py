import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from google import genai
from PIL import Image

# Carrega a chave salva no arquivo .env
load_dotenv()

api_key = os.getenv("GEMINI_API_KEY")

if not api_key:
    sys.exit(
        "Erro: GEMINI_API_KEY não encontrada. "
        "Confira o arquivo .env."
    )

# Cria o cliente para acessar a API do Gemini
client = genai.Client(api_key=api_key)


PROMPT = """
Analise a imagem para identificar um produto e ajudar a encontrá-lo
em um aplicativo de delivery.

Sua resposta DEVE conter os três campos abaixo, nesta ordem:

- Produto: nome mais provável do produto, incluindo marca e linha,
  se identificáveis.
- Detalhes: marca, tipo, sabor, variante, embalagem, tamanho ou
  quantidade, conforme visíveis na imagem. Se algum detalhe não
  puder ser identificado, não o invente. Para produtos sem marca,
  descreva suas características visíveis.
- Termos de busca: forneça até 3 consultas curtas que ajudem a
  encontrar o produto em um aplicativo de delivery.

Regras:
- Sempre retorne os três campos, mesmo que algum detalhe seja incerto.
- Responda em português, com no máximo 70 palavras.
- Seja conciso e use somente informações úteis para a busca.
- Não invente informações que não estejam visíveis ou não possam
  ser identificadas com segurança.
- Não inclua introdução nem explicações adicionais.
"""



def analisar_imagem(caminho_imagem):
    caminho = Path(caminho_imagem)

    if not caminho.is_file():
        sys.exit(f"Erro: imagem não encontrada: {caminho}")

    try:
        with Image.open(caminho) as imagem:
            imagem.load()

            resposta = client.models.generate_content(
                model="gemini-3.8-flash",
                contents=[PROMPT, imagem],
                config={"max_output_tokens": 1000},
            )

        
        if resposta.text:
            print("\n--- Produto identificado ---\n")
            print(resposta.text)
        else:
            print("O Gemini não retornou texto.")


    except Exception as erro:
        print(f"Erro ao consultar o Gemini: {erro}")
        print("Confira a conexão, a chave da API e o modelo utilizado.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(
            'Uso: python main.py "caminho/para/imagem.jpg"'
        )

    analisar_imagem(sys.argv[1])
