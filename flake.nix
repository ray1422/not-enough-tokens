{
  description = "Claude Code usage across machines, with a local web console";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
    in
    {
      packages = forAll (pkgs: rec {
        not-enough-tokens = pkgs.callPackage ./packaging/nix/package.nix {
          src = self;
          inherit version;
        };
        default = not-enough-tokens;
      });

      apps = forAll (pkgs: let pkg = self.packages.${pkgs.stdenv.hostPlatform.system}.default; in {
        default = { type = "app"; program = "${pkg}/bin/not-enough-tokens"; };
        cli = { type = "app"; program = "${pkg}/bin/net"; };
      });
    };
}
