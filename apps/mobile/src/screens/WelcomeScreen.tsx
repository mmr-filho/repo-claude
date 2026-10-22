import { useState } from 'react';
import { KeyboardAvoidingView, ScrollView, View } from 'react-native';
import { LocalNode, decodeCode, type Invite, type NodeDeps } from '@sigilo/core/v2';
import { biometricAvailable, saveBiometricKey } from '../biometric';
import { ScanSheet } from '../components/ScanSheet';
import { RELAY_URL } from '../config';
import { errorText } from '../errors';
import { PASSWORD_RULE, passwordProblem, weakPasswordHint } from '../password';
import { normalizeServerUrl } from '../server-url';
import { Banner, Body, Button, Card, Check, Field, H1, H2, Muted, Row, Screen } from '../ui';

type Mode = 'choose' | 'join' | 'create';

/** Primeiro uso: entrar numa rede com um convite do administrador, ou criar uma rede (sendo o administrador). */
export function WelcomeScreen({ deps, onNode }: { deps: NodeDeps; onNode: (node: LocalNode, opts: { biometric: boolean }) => void }) {
  const [mode, setMode] = useState<Mode>('choose');
  const [invite, setInvite] = useState('');
  const [name, setName] = useState('');
  const [networkName, setNetworkName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const canBiometric = biometricAvailable();
  const [useBiometric, setUseBiometric] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [scanning, setScanning] = useState(false);
  const hint = weakPasswordHint(password);

  async function submit() {
    setError(undefined);
    try {
      const problem = passwordProblem(password, confirm);
      if (problem) throw new Error(problem);
      let node: LocalNode;
      if (mode === 'join') {
        const code = invite.trim();
        const decoded = decodeCode<Invite>('invite', code);
        normalizeServerUrl(decoded.relay); // exige HTTPS (exceto rede local)
        setBusy(true);
        node = await LocalNode.join(deps, { password, inviteCode: code });
      } else {
        if (name.trim().length < 2) throw new Error('Informe o seu nome');
        if (networkName.trim().length < 2) throw new Error('Informe o nome da rede');
        if (!RELAY_URL) throw new Error('Este app ainda não tem um relé configurado, então não dá para criar uma rede por aqui.');
        const relayUrl = normalizeServerUrl(RELAY_URL);
        setBusy(true);
        node = await LocalNode.createNetwork(deps, { password, adminName: name.trim(), networkName: networkName.trim(), relayUrl });
      }
      // Digital: guarda a chave do cofre no armazenamento protegido pelo hardware. Se a pessoa cancelar, segue só com a senha.
      let biometric = false;
      if (canBiometric && useBiometric) {
        try {
          await saveBiometricKey(await node.exportVaultKey(password));
          biometric = true;
        } catch {
          biometric = false;
        }
      }
      onNode(node, { biometric });
    } catch (err) {
      setError(err instanceof Error && /tipo errado|JSON|Unexpected|base64/i.test(err.message) ? 'Convite inválido. Confira se copiou o código inteiro.' : errorText(err));
      setBusy(false);
    }
  }

  const passwordFields = (
    <>
      <Field label="Escolha uma senha" value={password} onChangeText={setPassword} secureTextEntry textContentType="newPassword" />
      <Field label="Repita a senha" value={confirm} onChangeText={setConfirm} secureTextEntry textContentType="newPassword" />
      <Muted>{PASSWORD_RULE}</Muted>
      {hint ? <Banner kind="warn">{hint}</Banner> : null}
      {canBiometric ? <Check label="Destravar com a digital (a senha continua valendo)" checked={useBiometric} onChange={setUseBiometric} /> : null}
      <Banner kind="warn">
        Esta senha protege as suas chaves e não existe em nenhum outro lugar. Se você a esquecer, não há como recuperar: será preciso um convite novo e as conversas pendentes se perdem.
      </Banner>
    </>
  );

  return (
    <Screen>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ paddingVertical: 24, gap: 16 }} keyboardShouldPersistTaps="handled">
          <View style={{ gap: 4 }}>
            <H1>🔒 Sigilo</H1>
            <Muted>Conversas sem testemunhas e sem registros: cifradas, sem servidor de contas, e que se apagam depois de lidas.</Muted>
          </View>

          {mode === 'choose' ? (
            <>
              <Card>
                <H2>Tenho um convite</H2>
                <Muted>O administrador da sua rede gerou um convite para você: um código ou um QR code.</Muted>
                <Button title="Entrar com convite" onPress={() => setMode('join')} />
              </Card>
              <Card>
                <H2>Vou administrar uma rede</H2>
                <Muted>Você cria a rede, convida as pessoas e decide com quais outras redes ela se conecta. A chave da rede fica só neste aparelho.</Muted>
                {!RELAY_URL ? <Banner kind="warn">Este app ainda não tem um relé configurado. Criar rede fica indisponível até lá; entrar com convite funciona.</Banner> : null}
                <Button title="Criar uma rede" variant="secondary" onPress={() => setMode('create')} disabled={!RELAY_URL} />
              </Card>
            </>
          ) : null}

          {mode === 'join' ? (
            <>
              <Card>
                <H2>Entrar com convite</H2>
                <Field label="Código do convite" value={invite} onChangeText={setInvite} multiline numberOfLines={3} placeholder="sigilo2-convite:…" style={{ minHeight: 80, textAlignVertical: 'top' }} />
                <Button title="Ler QR code" variant="secondary" onPress={() => setScanning(true)} small />
              </Card>
              <Card>{passwordFields}</Card>
            </>
          ) : null}

          {mode === 'create' ? (
            <Card>
              <H2>Criar uma rede</H2>
              <Field label="Seu nome" value={name} onChangeText={setName} autoCapitalize="words" />
              <Field label="Nome da rede" value={networkName} onChangeText={setNetworkName} autoCapitalize="words" />
              {passwordFields}
            </Card>
          ) : null}

          {error ? <Banner kind="error">{error}</Banner> : null}
          {mode !== 'choose' ? (
            <>
              <Button title={mode === 'join' ? 'Entrar na rede' : 'Criar rede'} onPress={submit} busy={busy} />
              {busy ? <Body>Gerando as chaves de segurança… isso pode levar alguns segundos.</Body> : null}
              <Row style={{ justifyContent: 'center' }}>
                <Button title="Voltar" variant="ghost" onPress={() => { setMode('choose'); setError(undefined); }} />
              </Row>
            </>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
      <ScanSheet visible={scanning} onClose={() => setScanning(false)} onCode={(c) => { setInvite(c); setScanning(false); }} />
    </Screen>
  );
}
