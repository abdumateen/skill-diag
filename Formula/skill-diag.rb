# Homebrew formula for skill-diag.
# Structure stub: replace the placeholder sha256 with the real one on release
# (shasum -a 256 on the downloaded tarball).
class SkillDiag < Formula
  desc "Diagnose why AI coding agent skills fail to load, route, or scale"
  homepage "https://github.com/OWNER/skill-diag"
  url "https://registry.npmjs.org/skill-diag/-/skill-diag-0.2.0.tgz"
  version "0.2.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000" # placeholder

  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink libexec/"bin/skill-diag"
  end

  test do
    system bin/"skill-diag", "--version"
  end
end
