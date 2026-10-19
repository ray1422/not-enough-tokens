# The app on nixpkgs' electron (nothing bundled), plus the `net` CLI on plain node.
# ssh, curl (askpass callback) and git (project grouping) are put on PATH.
{
  lib,
  stdenvNoCC,
  makeWrapper,
  electron,
  nodejs,
  openssh,
  curl,
  git,
  src,
  version,
}:

stdenvNoCC.mkDerivation {
  pname = "not-enough-tokens";
  inherit version src;

  nativeBuildInputs = [ makeWrapper ];
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    app=$out/lib/not-enough-tokens
    mkdir -p $app
    cp -r package.json LICENSE electron src web $app/

    path=${lib.makeBinPath [ openssh curl git ]}
    makeWrapper ${lib.getExe electron} $out/bin/not-enough-tokens \
      --add-flags $app --prefix PATH : $path
    makeWrapper ${lib.getExe nodejs} $out/bin/net \
      --add-flags $app/src/cli.js --prefix PATH : $path

    install -Dm644 packaging/linux/not-enough-tokens.desktop -t $out/share/applications
    substituteInPlace $out/share/applications/not-enough-tokens.desktop \
      --replace-fail 'Exec=not-enough-tokens' "Exec=$out/bin/not-enough-tokens"
    install -Dm644 build/icon.svg $out/share/icons/hicolor/scalable/apps/not-enough-tokens.svg
    install -Dm644 build/icon.png $out/share/icons/hicolor/512x512/apps/not-enough-tokens.png

    runHook postInstall
  '';

  meta = {
    description = "Claude Code usage across machines, with a local web console";
    homepage = "https://github.com/ray1422/not-enough-tokens";
    license = lib.licenses.bsd3;
    platforms = lib.platforms.linux;
    mainProgram = "not-enough-tokens";
  };
}
