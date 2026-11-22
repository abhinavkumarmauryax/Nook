Name:           nook
Version:        2.0.0
Release:        1%{?dist}
Summary:        Self-hosted watch-together rooms with synchronized video and chat

License:        SEE LICENSE IN LICENSE
URL:            https://github.com/abhinavkumarmauryax/Nook
Source0:        nook-linux-x64
Source1:        nook.desktop
Source2:        nook-icon.png

%description
Nook lets friends on the same network (or a VPN/tunnel) watch the same video
in sync and chat in real time, with owner, admin and member roles. It is fully
self-hosted and needs no cloud service.

%install
mkdir -p %{buildroot}%{_bindir}
mkdir -p %{buildroot}%{_datadir}/applications
mkdir -p %{buildroot}%{_datadir}/icons/hicolor/256x256/apps
install -m 0755 %{SOURCE0} %{buildroot}%{_bindir}/nook
install -m 0644 %{SOURCE1} %{buildroot}%{_datadir}/applications/nook.desktop
install -m 0644 %{SOURCE2} %{buildroot}%{_datadir}/icons/hicolor/256x256/apps/nook.png

%files
%{_bindir}/nook
%{_datadir}/applications/nook.desktop
%{_datadir}/icons/hicolor/256x256/apps/nook.png

%changelog
* Sun Nov 22 2026 Abhi <noreply@localhost> - 2.0.0-1
- Nook 2.0.0 release
