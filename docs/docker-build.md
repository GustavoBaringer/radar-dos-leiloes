# Build Docker do backend

O estágio de build instala `ca-certificates` e OpenSSL para o Prisma. Em uma rede com CA personalizada já confiada, forneça o certificado público como secret do BuildKit. Ele fica disponível somente durante instalação e compilação, sem ser copiado para a imagem:

```sh
docker build --secret id=corporate_ca,src="${NODE_EXTRA_CA_CERTS}" \
  --target backend-build -t radar-nest-migration:backend .
```

Em redes que já confiam no certificado do servidor, omita `--secret`. A verificação TLS permanece ativa; não inclua certificados personalizados nem chaves privadas nas camadas da imagem.
